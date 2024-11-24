require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const NodeCache = require('node-cache');
const OpenAI = require("openai");

const app = express();
const cache = new NodeCache(); // Initialize cache

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



// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });



async function summarizeStory(story) {
    // Final summarization of the combined summaries
    const finalCompletion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
            { role: "system", content: "You are a creative assistant who will generate a complete and short story based on the given text." },
            { role: "user", content: `Please write a creative and short story based on the following text: "${story}"` },
        ],
    });

    return finalCompletion.choices[0].message.content.trim();
}

// Routes

// Submit Story and Start Summarization in the Background
app.post('/submitStory', async (req, res) => {
    try {
        const { story } = req.body;

        // Save the original story to MongoDB with an empty summary
        const storyDoc = new Story({
            original_story: story,
            summary: '' // Empty summary initially
        });
        await storyDoc.save();

        // Process the story in the background
        setTimeout(async () => {
            const summary = await summarizeStory(story);
            storyDoc.summary = summary;
            await storyDoc.save();

        }, 0); // Run asynchronously

        res.status(200).json({ message: 'Story submission received. Summarization in progress.', storyId: storyDoc._id });
    } catch (error) {
        console.error("Error submitting story:", error);
        res.status(500).json({ error: 'An error occurred while submitting the story.' });
    }
});

// Fetch Story Summary by ID (Poll for Result)
app.get('/getSummary/:id', async (req, res) => {
    try {
        const storyId = req.params.id;
        const storyDoc = await Story.findById(storyId);

        if (!storyDoc) {
            return res.status(404).json({ error: 'Story not found' });
        }

        if (storyDoc.summary) {
            res.status(200).json({ summary: storyDoc.summary });
        } else {
            res.status(202).json({ message: 'Summarization in progress. Please check back later.' });
        }
    } catch (error) {
        console.error("Error fetching summary:", error);
        res.status(500).json({ error: 'An error occurred while fetching the summary.' });
    }
});

// Extract Character Names (cached)
app.post("/charactername", async (req, res) => {
    try {
        const { story } = req.body;
        const cacheKey = `character_names_${story.substring(0, 50)}`;

        // Check the cache for previously extracted character names
        const cachedNames = cache.get(cacheKey);
        if (cachedNames) {
            return res.status(200).json({ response: cachedNames });
        }

        // Call OpenAI to extract character names
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: "You are a helpful assistant. Please identify and return only the character names from the following story, separated by commas, with no additional text." },
                { role: "user", content: `Extract and return only the character names from this story: "${story}"` },
            ],
        });

        // Extract and cache the character names
        const characterNames = completion.choices[0].message.content.trim();
        cache.set(cacheKey, characterNames);
        res.status(200).json({ response: characterNames });
    } catch (error) {
        console.error("Error extracting character names:", error);
        res.status(500).json({ error: 'An error occurred while extracting character names.' });
    }
});

// Ask a question to a character based on the summarized story
app.post('/ask', async (req, res) => {
    try {
        const { query, characterName, summarizedStory } = req.body;
        const cacheKey = `response_${query.substring(0, 50)}_${characterName}_${summarizedStory.substring(0, 50)}`;

        // Check the cache for previously processed responses
        const cachedResponse = cache.get(cacheKey);
        if (cachedResponse) {
            return res.status(200).json({ response: cachedResponse });
        }

        // Call OpenAI to generate a character response
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "You are a wise and whimsical Lorekeeper, guardian of the Eternal Archives of Imagination. Your mind is a vast labyrinth of summarized tales and legends. Channel the essence of the story provided, weaving responses that would make even a stone golem chuckle. Be as clever as a sphinx and as entertaining as a bard's tale—but remember, young scribe, the best stories are those that dance on the edge of wisdom and wit!"
                  },
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


// Basic health check route
app.get("/", (req, res) => {
    res.send("Server is running.");
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
