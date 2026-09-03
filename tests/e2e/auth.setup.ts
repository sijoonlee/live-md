import {test as setup} from "@playwright/test";
import {authFile} from "./auth-file";

// Establish a human session once (via the test-only dev-login seam) and save the
// cookie as storage state. Test projects reuse it so editing tests run signed in.
setup("authenticate", async ({request}) => {
  await request.post("/auth/dev-login", {data: {name: "E2E User"}});
  await request.storageState({path: authFile});
});
