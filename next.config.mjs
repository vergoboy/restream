// basePath must match the nginx location and the rtmp on_publish callback
export default { basePath: '/noisy', experimental: { instrumentationHook: true, serverComponentsExternalPackages: ['better-sqlite3'] } };
