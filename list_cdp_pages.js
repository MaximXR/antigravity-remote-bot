const http = require('http');

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function run() {
    const ports = [9222, 9223, 9333, 9444, 9555, 9666];
    for (const port of ports) {
        try {
            const pages = await getJson(`http://localhost:${port}/json/list`);
            console.log(`\n=== Port ${port} ===`);
            pages.forEach(p => {
                console.log(`- Title: "${p.title}" | Type: ${p.type} | URL: ${p.url}`);
            });
        } catch (e) {
            console.log(`Port ${port}: closed or error (${e.message})`);
        }
    }
}
run();
