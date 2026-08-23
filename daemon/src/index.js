import { loadConfig } from "./config.js";
import { start } from "./server.js";

start(loadConfig());
