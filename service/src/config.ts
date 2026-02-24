export const config = {
  port: parseInt(process.env.PORT ?? "3001"),
  grpcPort: parseInt(process.env.GRPC_PORT ?? "50051"),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY ?? "15m",
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY ?? "30d",
  dbPath: process.env.DB_PATH ?? "../data/app.db",
};
