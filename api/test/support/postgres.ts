import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export const POSTGRES_IMAGE = 'postgres:18.7-alpine';

export const CONTAINER_START_TIMEOUT_MS = 120_000;

const DATABASE_NAME = 'pos';
const SUPERUSER = 'postgres';
const ROLES_SCRIPT = fileURLToPath(new URL('../../../deploy/initdb/01-roles.sh', import.meta.url));

export type TestDatabase = {
  superuserUrl: string;
  migratorUrl: string;
  appUrl: string;
  stop: () => Promise<void>;
};

function randomPassword(): string {
  return randomBytes(18).toString('hex');
}

function databaseUrl(
  container: StartedPostgreSqlContainer,
  user: string,
  password: string,
): string {
  return `postgres://${user}:${password}@${container.getHost()}:${String(container.getPort())}/${DATABASE_NAME}`;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const superuserPassword = randomPassword();
  const migratorPassword = randomPassword();
  const appPassword = randomPassword();

  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(DATABASE_NAME)
    .withUsername(SUPERUSER)
    .withPassword(superuserPassword)
    .withEnvironment({ MIGRATOR_PASSWORD: migratorPassword, APP_DB_PASSWORD: appPassword })
    // 0755 so the entrypoint executes the script; a non-executable .sh is sourced into its own shell.
    .withCopyFilesToContainer([
      { source: ROLES_SCRIPT, target: '/docker-entrypoint-initdb.d/01-roles.sh', mode: 0o755 },
    ])
    .start();

  return {
    superuserUrl: databaseUrl(container, SUPERUSER, superuserPassword),
    migratorUrl: databaseUrl(container, 'migrator', migratorPassword),
    appUrl: databaseUrl(container, 'pos_app', appPassword),
    stop: async () => {
      await container.stop();
    },
  };
}
