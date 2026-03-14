package model

import "time"

type Subscription struct {
	ID                 string     `json:"id"`
	OrgID              string     `json:"orgId"`
	PlanID             string     `json:"planId"`
	Status             string     `json:"status"`
	Cycle              string     `json:"cycle"`
	CurrentPeriodStart time.Time  `json:"currentPeriodStart"`
	CurrentPeriodEnd   time.Time  `json:"currentPeriodEnd"`
	CancelAtPeriodEnd  bool       `json:"cancelAtPeriodEnd"`
	TrialEnd           *time.Time `json:"trialEnd,omitempty"`
}

type Invoice struct {
	ID          string     `json:"id"`
	OrgID       string     `json:"orgId"`
	Amount      float64    `json:"amount"`
	Status      string     `json:"status"`
	Description string     `json:"description"`
	PeriodStart time.Time  `json:"periodStart"`
	PeriodEnd   time.Time  `json:"periodEnd"`
	PaidAt      *time.Time `json:"paidAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
}

type PaymentMethod struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`
	Brand     *string `json:"brand,omitempty"`
	Last4     *string `json:"last4,omitempty"`
	ExpMonth  *int    `json:"expMonth,omitempty"`
	ExpYear   *int    `json:"expYear,omitempty"`
	IsDefault bool    `json:"isDefault"`
}

type UsageAlert struct {
	ID          string  `json:"id"`
	OrgID       string  `json:"orgId"`
	Metric      string  `json:"metric"`
	Threshold   float64 `json:"threshold"`
	NotifyEmail bool    `json:"notifyEmail"`
	NotifyInApp bool    `json:"notifyInApp"`
	Enabled     bool    `json:"enabled"`
}
