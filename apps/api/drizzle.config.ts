import type { Config } from "drizzle-kit";

export default {
  schema: ["./src/db/schema.ts", "./src/db/buildControl.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
} satisfies Config;
