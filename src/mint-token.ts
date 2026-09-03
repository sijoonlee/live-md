import {mintAgentToken} from "./auth.js";

// Bootstrap token issuer. Mints an agent principal and its first token directly
// against the local database — trusted because it runs on the host. This is the
// pre-human-auth way to provision agents; once human auth lands, tokens are also
// mintable from the browser UI (M14 part B).
//
// Usage: npm run mint-token -- --name "researcher-bot"

const args = process.argv.slice(2);
let name: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--name") name = args[i + 1];
  else if (args[i].startsWith("--name=")) name = args[i].slice("--name=".length);
}

if (!name || name.trim().length === 0) {
  console.error('Usage: npm run mint-token -- --name "agent name"');
  process.exit(1);
}

const {principal, token} = mintAgentToken(name.trim());

console.log(`Created agent principal #${principal.id} "${principal.displayName}".`);
console.log("");
console.log("  API token (shown once — copy it now, it is not stored):");
console.log(`  ${token}`);
console.log("");
console.log("Set it on the agent as AGENT_TOKEN and pass it to AgentClient({ token }).");
process.exit(0);
