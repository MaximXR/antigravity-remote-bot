import { loadConfig } from '../src/utils/config';
import { ConfigLoader } from '../src/utils/configLoader';

console.log('--- Config Directory Paths ---');
console.log('Config Dir:', ConfigLoader.getConfigDir());
console.log('Config File Path:', ConfigLoader.getConfigFilePath());

console.log('\n--- Raw File Content ---');
try {
    const fs = require('fs');
    if (fs.existsSync(ConfigLoader.getConfigFilePath())) {
        console.log(fs.readFileSync(ConfigLoader.getConfigFilePath(), 'utf-8'));
    } else {
        console.log('Config file does not exist on disk at that path!');
    }
} catch (err) {
    console.error('Failed to read raw config file:', err);
}

console.log('\n--- Loaded Configuration Object ---');
try {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
} catch (err) {
    console.error('Failed to load config:', err);
}
