const http = require('http');

function getAvailableModel() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:11434/api/tags', (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (parsed.models && parsed.models.length > 0) {
                        // Prioritize a smaller model if available, otherwise just pick the first one
                        const smaller = parsed.models.find(m => m.name.includes('2b') || m.name.includes('1b') || m.name.includes('3b') || m.name.includes('8b'));
                        resolve(smaller ? smaller.name : parsed.models[0].name);
                    } else {
                        reject(new Error("No Ollama models found. Please pull a model."));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function generateOllamaResponse(prompt) {
    let modelName = 'gemma4:26b';
    try {
        modelName = await getAvailableModel();
    } catch (e) {
        console.warn("Could not fetch Ollama models, defaulting to", modelName);
    }

    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: modelName,
            prompt: prompt,
            stream: false
        });

        const req = http.request({
            hostname: '127.0.0.1',
            port: 11434,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error('Ollama error (' + modelName + '): ' + body));
                try {
                    const parsed = JSON.parse(body);
                    resolve(parsed.response);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        req.write(postData);
        req.end();
    });
}

module.exports = { generateOllamaResponse };
