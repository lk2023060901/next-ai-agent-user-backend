import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./index.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPathCandidates = [
  path.join(__dirname, "../../drizzle"),
  path.join(__dirname, "../../../drizzle"),
  path.join(process.cwd(), "drizzle"),
];

const migrationsFolder =
  migrationPathCandidates.find((candidate) => fs.existsSync(candidate)) ??
  migrationPathCandidates[0];

migrate(db, { migrationsFolder });
console.log(`Migrations applied from: ${migrationsFolder}`);
