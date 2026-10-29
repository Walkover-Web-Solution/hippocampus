// Per-key FIFO mutex for serializing graph commits per scope (one writer per partition, as with
// Kafka partitions or a per-key actor). Keys are taken in sorted order, so two writers that need
// overlapping scopes can't deadlock. In-process only: a deployment with several consumers needs
// the same guarantee from routing (one consumer per scope) or a database lock.
export class KeyedMutex {
    private tails = new Map<string, Promise<void>>();

    async run<T>(keys: string[], task: () => Promise<T>): Promise<T> {
        const releases: (() => void)[] = [];
        for (const key of [...new Set(keys)].sort()) {
            const previous = this.tails.get(key) ?? Promise.resolve();
            let release!: () => void;
            const held = new Promise<void>((resolve) => (release = resolve));
            const tail = previous.then(() => held);
            this.tails.set(key, tail);
            await previous;
            releases.push(() => {
                release();
                if (this.tails.get(key) === tail) this.tails.delete(key);
            });
        }
        try {
            return await task();
        } finally {
            for (const release of releases.reverse()) release();
        }
    }
}
