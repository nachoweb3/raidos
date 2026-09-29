import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Resolve from the module, so both src/api and dist/api load the repository root.
// Existing server/Fly environment variables always take precedence.
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), override: false });
