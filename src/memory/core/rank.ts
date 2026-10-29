// Reciprocal rank fusion (as in Zep's retrieval): items ranked high by several searches rise to the top,
// without having to calibrate the searches' scores against each other.
export function reciprocalRankFusion<T>(lists: T[][], key: (item: T) => string, k = 60): T[] {
    const scores = new Map<string, { item: T; score: number }>();
    for (const list of lists) {
        list.forEach((item, rank) => {
            const id = key(item);
            const entry = scores.get(id) ?? { item, score: 0 };
            entry.score += 1 / (k + rank + 1);
            scores.set(id, entry);
        });
    }
    return [...scores.values()].sort((a, b) => b.score - a.score).map((e) => e.item);
}

// Personalized PageRank (as in HippoRAG, after the hippocampal indexing theory): random walks that
// restart at the seed nodes spread activation along edges, so nodes linking several seeds (the
// bridges a multi-hop question needs) score high. Edges are undirected; seeds map node -> weight.
// damping is the chance of following an edge instead of jumping back to a seed.
export function personalizedPageRank(edges: [string, string][], seeds: Map<string, number>, damping = 0.5, iterations = 30): Map<string, number> {
    const neighbours = new Map<string, string[]>();
    const link = (from: string, to: string) => {
        const list = neighbours.get(from);
        if (list) list.push(to);
        else neighbours.set(from, [to]);
    };
    for (const [a, b] of edges) {
        if (a === b) continue;
        link(a, b);
        link(b, a);
    }
    const total = [...seeds.values()].reduce((sum, w) => sum + w, 0);
    if (total <= 0) return new Map();
    const restart = new Map([...seeds].map(([node, w]) => [node, w / total] as const));
    let rank = new Map(restart);
    for (let i = 0; i < iterations; i++) {
        const next = new Map<string, number>();
        const add = (node: string, value: number) => next.set(node, (next.get(node) ?? 0) + value);
        for (const [node, w] of restart) add(node, (1 - damping) * w);
        for (const [node, score] of rank) {
            const out = neighbours.get(node);
            // A node without edges sends its walkers back to the seeds.
            if (!out) for (const [seed, w] of restart) add(seed, damping * score * w);
            else for (const to of out) add(to, (damping * score) / out.length);
        }
        rank = next;
    }
    return rank;
}

const STOPWORDS = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'what', 'when', 'who', 'whom', 'which', 'how', 'does', 'did',
    'has', 'have', 'had', 'with', 'from', 'that', 'this', 'there', 'they', 'their', 'our', 'your', 'you', 'can', 'will', 'would',
    'should', 'about', 'into', 'now', 'any', 'all', 'its', 'not', 'but', 'his', 'her', 'she', 'him', 'them', 'than', 'then']);

// Content words of a question, for full-text search (alphanumeric only, so safe for tsquery/Lucene).
export function queryWords(text: string, max = 12): string[] {
    const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    return [...new Set(words)].slice(0, max);
}
