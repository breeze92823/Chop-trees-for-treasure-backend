import { listen } from "@colyseus/tools";

import app from "./app.config.js";

// Listens on PORT (or 2567).
listen(app);
