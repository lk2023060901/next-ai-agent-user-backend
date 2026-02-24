import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./index";
import path from "path";

const migrationsFolder = path.join(__dirname, "../../drizzle");

migrate(db, { migrationsFolder });
console.log("Migrations applied.");
