import { execFileSync } from "node:child_process";

// Tests run against the real PostgreSQL from docker-compose.yml.
export default function setup() {
  execFileSync("docker", ["compose", "up", "-d", "--wait", "postgres"], { stdio: "inherit" });
}
