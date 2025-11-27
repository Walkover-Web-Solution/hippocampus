export const chunkTextWithOverlap = (text: string, chunkSize: number, overlapSize: number) => {
    const chunks = [];
    for (let i = 0; i < text.length; i += (chunkSize - overlapSize)) {
        const chunk = text.slice(i, i + chunkSize);
        chunks.push(chunk);
        if (i + chunkSize >= text.length) {
            break;
        }
    }
    return chunks;
};

export const calculateVectorSize = (vector: any) => {
    const serializedVector = JSON.stringify(vector);
    return Buffer.byteLength(serializedVector, 'utf8');
};