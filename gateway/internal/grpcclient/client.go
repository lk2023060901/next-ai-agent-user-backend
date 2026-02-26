package grpcclient

import (
	"sync"

	authpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/auth"
	chatpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/chat"
	orgpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/org"
	channelspb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/channels"
	schedulerpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/scheduler"
	settingspb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/settings"
	toolspb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/tools"
	workspacepb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/workspace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type Clients struct {
	Auth      authpb.AuthServiceClient
	Chat      chatpb.ChatServiceClient
	Org       orgpb.OrgServiceClient
	Workspace workspacepb.WorkspaceServiceClient
	Settings  settingspb.SettingsServiceClient
	Tools     toolspb.ToolsServiceClient
	Channels  channelspb.ChannelsServiceClient
	Scheduler schedulerpb.SchedulerServiceClient
	conn      *grpc.ClientConn
}

var (
	instance *Clients
	once     sync.Once
)

func New(addr string) (*Clients, error) {
	var err error
	once.Do(func() {
		var conn *grpc.ClientConn
		conn, err = grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			return
		}
		instance = &Clients{
			Auth:      authpb.NewAuthServiceClient(conn),
			Chat:      chatpb.NewChatServiceClient(conn),
			Org:       orgpb.NewOrgServiceClient(conn),
			Workspace: workspacepb.NewWorkspaceServiceClient(conn),
			Settings:  settingspb.NewSettingsServiceClient(conn),
			Tools:     toolspb.NewToolsServiceClient(conn),
			Channels:  channelspb.NewChannelsServiceClient(conn),
			Scheduler: schedulerpb.NewSchedulerServiceClient(conn),
			conn:      conn,
		}
	})
	return instance, err
}

func (c *Clients) Close() error {
	return c.conn.Close()
}
