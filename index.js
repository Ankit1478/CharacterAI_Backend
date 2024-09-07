require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { ChromaClient, OpenAIEmbeddingFunction } = require('chromadb');
const OpenAI = require("openai");
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes

// Middleware
app.use(cors({
    origin: ['https://my-app-peach-xi.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
  }));
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('Connected to MongoDB'));

// Define MongoDB Schema and Model
const storySchema = new mongoose.Schema({
    original_story: String,
    summary: String,
    createdAt: { type: Date, default: Date.now }
});
const Story = mongoose.model('Story', storySchema);

// Initialize ChromaDB
const chromaClient = new ChromaClient({ path: process.env.CHROMA_CLIENT_PATH });
const embedder = new OpenAIEmbeddingFunction({ openai_api_key: process.env.OPENAI_API_KEY });
let collection;

(async () => {
    collection = await chromaClient.getOrCreateCollection({
        name: "story_summaries",
        embeddingFunction: embedder
    });
})();

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper Functions
function chunkStory(story, maxChunkSize = 1000) {
    const words = story.split(' ');
    const chunks = [];
    let currentChunk = '';

    for (const word of words) {
        if ((currentChunk + ' ' + word).length <= maxChunkSize) {
            currentChunk += (currentChunk ? ' ' : '') + word;
        } else {
            chunks.push(currentChunk);
            currentChunk = word;
        }
    }
    if (currentChunk) {
        chunks.push(currentChunk);
    }
    return chunks;
}

async function summarizeStory(story) {
    const chunks = chunkStory(story);
    let fullSummary = '';

    for (const chunk of chunks) {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o", 
            messages: [
                { role: "system", content: "You are a helpful assistant who will summarize information concisely." },
                { role: "user", content: `Please summarize the following text: "${chunk}"` },
            ],
        });
        fullSummary += completion.choices[0].message.content.trim() + ' ';
    }

    // Final summarization of the combined summaries
    const finalCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: "You are a creative assistant who will generate a complete story based on the given text." },
            { role: "user", content: `Please write a creative  story based on the following text: "${story}"` },
        ],
    });
    

    return finalCompletion.choices[0].message.content.trim();
}

// Routes
app.post('/add', async (req, res) => {
    try {
        const { story } = req.body;
        
        const summary = await summarizeStory(story);
        const storyDoc = new Story({
            original_story: story,
            summary: summary
        });

        await storyDoc.save();

        await collection.add({
            ids: [storyDoc._id.toString()],
            documents: [summary],
            metadatas: [{ original_story: story.substring(0, 1000) + '...' }]
        });

        res.status(200).json({ message: 'Story added and summarized successfully!', summary: summary });
    } catch (error) {
        console.error("Error adding story:", error);
        res.status(500).json({ error: 'An error occurred while adding the story.' });
    }
});

app.post("/charactername", async (req, res) => {
    try {
        const { story } = req.body;
        const cacheKey = `character_names_${story.substring(0, 50)}`;
        
        const cachedNames = cache.get(cacheKey);
        if (cachedNames) {
            return res.status(200).json({ response: cachedNames });
        }

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "You are a helpful assistant. Please identify and return only the character names from the following story, separated by commas, with no additional text." },
                { role: "user", content: `Extract and return only the character names from this story: "${story}"` },
            ],
        });
        const characterNames = completion.choices[0].message.content.trim();
        
        cache.set(cacheKey, characterNames);
        res.status(200).json({ response: characterNames });
    } catch (error) {
        console.error("Error extracting character names:", error);
        res.status(500).json({ error: 'An error occurred while extracting character names.' });
    }
});

app.post('/ask', async (req, res) => {
    try {
        const { query, characterName, summarizedStory } = req.body;
        const cacheKey = `response_${query.substring(0, 50)}_${characterName}_${summarizedStory.substring(0, 50)}`;
        
        const cachedResponse = cache.get(cacheKey);
        if (cachedResponse) {
            return res.status(200).json({ response: cachedResponse });
        }

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "You are a helpful assistant with a brain full of summarized memories. Respond in character based on the story summary provided—make it funny, but keep it clever!" },
                { role: "user", content: `Here is a summarized story: "${summarizedStory}"` },
                { role: "user", content: `As the character "${characterName}", please answer this question: "${query}"` },
            ],
        });

        const response = completion.choices[0].message.content;
        cache.set(cacheKey, response);
        res.status(200).json({ response });
    } catch (error) {
        console.error("Error processing query:", error);
        res.status(500).json({ error: 'An error occurred while processing your query.' });
    }
});

app.get("/", (req, res) => {
    res.send("Server is running.");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});