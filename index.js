import express from 'express';
import cors from 'cors';
import { Innertube, UniversalCache } from 'youtubei.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

let yt;

async function initYoutube() {
    yt = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true
    });
}

initYoutube().then(() => console.log('YouTubei initialized')).catch(console.error);

app.get('/', (req, res) => {
    res.send('YouTube API is running');
});

app.get('/api/stream', async (req, res) => {
    try {
        const videoId = req.query.video_id;
        if (!videoId) {
            return res.status(400).json({ error: 'video_id is required' });
        }

        if (!yt) {
            return res.status(503).json({ error: 'YouTube API not initialized yet' });
        }

        const info = await yt.getBasicInfo(videoId);
        const format = info.chooseFormat({ type: 'audio', quality: 'best' });
        
        if (!format) {
            return res.status(404).json({ error: 'No audio format found' });
        }
        
        let url = format.url;
        if (!url) {
            url = format.decipher(yt.session.player);
        }

        if (!url) {
            return res.status(404).json({ error: 'Failed to extract stream URL' });
        }

        res.redirect(url);
    } catch (error) {
        console.error('Error fetching stream:', error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
