// Load .env into process.env at startup (Node's built-in loader). A no-op when
// there is no .env file, so real environment variables still work in deployment.
try {
  process.loadEnvFile();
} catch {
  // No .env present; rely on the ambient environment.
}
