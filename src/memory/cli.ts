import dotenv from 'dotenv';

dotenv.config();

/**
 * Operator commands that need no running server:
 *
 *   npm run memory:migrate              apply the memory schema to MEMORY_DATABASE_URL
 *   npm run memory:reindex -- [issuer] [org] [project]   rebuild every current version's index (of one tenant)
 */
async function main(): Promise<void> {
    const [command, ...args] = process.argv.slice(2);
    // Loaded here so dotenv has run first.
    const { migrateMemory, closeMemoryDb } = await import('./db');
    const { currentVersionIds, reindexVersions } = await import('./store/indexer');
    try {
        switch (command) {
            case 'migrate': {
                const applied = await migrateMemory();
                console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply');
                break;
            }
            case 'reindex': {
                const [issuer, orgId, projectId] = args;
                const ids = await currentVersionIds({ issuer, orgId, projectId });
                console.log(`reindexing ${ids.length} versions`);
                const result = await reindexVersions(ids);
                console.log(`indexed ${result.indexed}, failed ${result.failed}`);
                break;
            }
            default:
                console.error('usage: memory-cli migrate | reindex [issuer] [org] [project]');
                process.exitCode = 2;
        }
    } finally {
        await closeMemoryDb();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
