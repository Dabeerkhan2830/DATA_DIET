// Temporary: lets a Cloudflare quick-tunnel hostname past Vite's Host-header
// check. The dev server itself stays bound to loopback; delete this file and
// stop the tunnel when remote testing is finished.
import base from "./vite.config";
import type { UserConfig } from "vite";

const baseConfig = base as UserConfig;

export default {
  ...baseConfig,
  server: {
    ...baseConfig.server,
    host: "127.0.0.1",
    allowedHosts: [".trycloudflare.com"],
  },
};
