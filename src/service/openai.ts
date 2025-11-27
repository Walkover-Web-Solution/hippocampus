import { OpenAI } from "openai";

const openai: any = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY_EMBEDDING_RESPONSE_ENHANCE,
});

export const getOpenAIResponse = async (prompt: string) => {
    try {
        const apiResponse = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 100,
        });

        const result = apiResponse.choices[0].message.content.trim();
        const jsonMatch = result.match(/```json\n([\s\S]*?)\n```/);
        const jsonString = jsonMatch ? jsonMatch[1] : result;

        try {
            return JSON.parse(jsonString);
        } catch (jsonError) {
            if (jsonError instanceof SyntaxError) {
                return jsonString;
            }
            throw jsonError;
        }
    } catch (error) {
        console.error('Error fetching response from OpenAI:', error);
        throw error;
    }
};