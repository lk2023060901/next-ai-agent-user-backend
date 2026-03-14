package handler

import (
	"net/http"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var billLog = logger.Named("billing")

type BillingHandler struct {
	db *store.DB
}

func NewBillingHandler(db *store.DB) *BillingHandler {
	return &BillingHandler{db: db}
}

func (h *BillingHandler) Mount(r chi.Router) {
	r.Get("/pricing/plans", h.Plans)
	r.Get("/orgs/{orgId}/billing/subscription", h.GetSubscription)
	r.Patch("/orgs/{orgId}/billing/subscription", h.UpdateSubscription)
	r.Get("/orgs/{orgId}/billing/invoices", h.Invoices)
	r.Get("/orgs/{orgId}/billing/payment-methods", h.PaymentMethods)
	r.Post("/orgs/{orgId}/billing/payment-methods", h.AddPaymentMethod)
	r.Delete("/orgs/{orgId}/billing/payment-methods/{methodId}", h.DeletePaymentMethod)
	r.Get("/orgs/{orgId}/billing/alerts", h.Alerts)
	r.Patch("/orgs/{orgId}/billing/alerts/{alertId}", h.UpdateAlert)
}

func (h *BillingHandler) Plans(w http.ResponseWriter, r *http.Request) {
	plans := []map[string]interface{}{
		{"id": "free", "name": "Free", "description": "个人开发者", "monthlyPrice": 0, "yearlyPrice": 0,
			"features": []string{"1 Agent", "1000 消息/月", "基础模型"}, "limits": map[string]int{"agents": 1, "tokensPerMonth": 100000, "members": 1, "storageMb": 100}},
		{"id": "pro", "name": "Pro", "description": "专业团队", "monthlyPrice": 99, "yearlyPrice": 990, "popular": true,
			"features": []string{"10 Agents", "无限消息", "全部模型", "优先支持"}, "limits": map[string]int{"agents": 10, "tokensPerMonth": 1000000, "members": 5, "storageMb": 5000}},
		{"id": "enterprise", "name": "Enterprise", "description": "企业定制", "monthlyPrice": 0, "yearlyPrice": 0,
			"features": []string{"无限 Agents", "私有部署", "SLA", "专属支持"}, "limits": map[string]int{"agents": 9999, "tokensPerMonth": 99999999, "members": 999, "storageMb": 999999}},
	}
	billLog.Debug("get plans")
	writeData(w, plans)
}

func (h *BillingHandler) GetSubscription(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	sub := &model.Subscription{}
	err := h.db.QueryRow(r.Context(),
		store.Select("id", "org_id", "plan_id", "status", "cycle",
			"current_period_start", "current_period_end", "cancel_at_period_end", "trial_end").
			From("subscriptions").Where("org_id = ?", orgID),
	).Scan(&sub.ID, &sub.OrgID, &sub.PlanID, &sub.Status, &sub.Cycle,
		&sub.CurrentPeriodStart, &sub.CurrentPeriodEnd, &sub.CancelAtPeriodEnd, &sub.TrialEnd)
	if err != nil {
		billLog.Debug("no subscription found, returning default", zap.String("orgId", orgID))
		writeData(w, map[string]interface{}{
			"orgId": orgID, "planId": "free", "status": "active", "cycle": "monthly",
		})
		return
	}
	billLog.Debug("get subscription", zap.String("orgId", orgID))
	writeData(w, sub)
}

func (h *BillingHandler) UpdateSubscription(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	billLog.Debug("update subscription", zap.String("orgId", orgID))
	writeData(w, map[string]interface{}{"orgId": orgID, "planId": "free", "status": "active"})
}

func (h *BillingHandler) Invoices(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	rows, err := h.db.Query(r.Context(),
		store.Select("id", "org_id", "amount", "status", "description", "period_start", "period_end", "paid_at", "created_at").
			From("invoices").Where("org_id = ?", orgID).OrderBy("created_at DESC"))
	if err != nil {
		writeData(w, []model.Invoice{})
		return
	}
	defer rows.Close()
	var invoices []model.Invoice
	for rows.Next() {
		var i model.Invoice
		rows.Scan(&i.ID, &i.OrgID, &i.Amount, &i.Status, &i.Description, &i.PeriodStart, &i.PeriodEnd, &i.PaidAt, &i.CreatedAt)
		invoices = append(invoices, i)
	}
	if invoices == nil {
		invoices = []model.Invoice{}
	}
	billLog.Debug("get invoices", zap.String("orgId", orgID), zap.Int("count", len(invoices)))
	writeData(w, invoices)
}

func (h *BillingHandler) PaymentMethods(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	rows, err := h.db.Query(r.Context(),
		store.Select("id", "type", "brand", "last4", "exp_month", "exp_year", "is_default").
			From("payment_methods").Where("org_id = ?", orgID))
	if err != nil {
		writeData(w, []model.PaymentMethod{})
		return
	}
	defer rows.Close()
	var methods []model.PaymentMethod
	for rows.Next() {
		var m model.PaymentMethod
		rows.Scan(&m.ID, &m.Type, &m.Brand, &m.Last4, &m.ExpMonth, &m.ExpYear, &m.IsDefault)
		methods = append(methods, m)
	}
	if methods == nil {
		methods = []model.PaymentMethod{}
	}
	billLog.Debug("get payment methods", zap.String("orgId", orgID))
	writeData(w, methods)
}

func (h *BillingHandler) AddPaymentMethod(w http.ResponseWriter, r *http.Request) {
	billLog.Debug("add payment method")
	writeJSON(w, http.StatusCreated, apiResponse{Data: map[string]interface{}{"message": "ok"}})
}

func (h *BillingHandler) DeletePaymentMethod(w http.ResponseWriter, r *http.Request) {
	methodID := chi.URLParam(r, "methodId")
	_ = h.db.Exec(r.Context(), store.Delete("payment_methods").Where("id = ?", methodID))
	billLog.Debug("delete payment method", zap.String("methodId", methodID))
	w.WriteHeader(http.StatusNoContent)
}

func (h *BillingHandler) Alerts(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	rows, err := h.db.Query(r.Context(),
		store.Select("id", "org_id", "metric", "threshold", "notify_email", "notify_in_app", "enabled").
			From("usage_alerts").Where("org_id = ?", orgID))
	if err != nil {
		writeData(w, []model.UsageAlert{})
		return
	}
	defer rows.Close()
	var alerts []model.UsageAlert
	for rows.Next() {
		var a model.UsageAlert
		rows.Scan(&a.ID, &a.OrgID, &a.Metric, &a.Threshold, &a.NotifyEmail, &a.NotifyInApp, &a.Enabled)
		alerts = append(alerts, a)
	}
	if alerts == nil {
		alerts = []model.UsageAlert{}
	}
	billLog.Debug("get alerts", zap.String("orgId", orgID))
	writeData(w, alerts)
}

func (h *BillingHandler) UpdateAlert(w http.ResponseWriter, r *http.Request) {
	billLog.Debug("update alert")
	writeData(w, map[string]interface{}{"message": "ok"})
}
