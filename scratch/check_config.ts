import { loadConfig } from '../src/utils/config';
import { ConfigLoader } from '../src/utils/configLoader';

console.log('--- Config Directory Paths ---');
console.log('Config Dir:', ConfigLoader.getConfigDir());
console.log('Config File Path:', ConfigLoader.getConfigFilePath());

console.log('\n--- Environment Variables ---');
console.log('AUTO_APPROVE:', process.env.AUTO_APPROVE);
console.log('AUTO_APPROVE_FILE_EDITS:', process.env.AUTO_APPROVE_FILE_EDITS);
console.log('AUTO_APPROVE_CONSOLE_COMMANDS:', process.env.AUTO_APPROVE_CONSOLE_COMMANDS);
console.log('AUTO_APPROVE_READ_ACCESS:', process.env.AUTO_APPROVE_READ_ACCESS);
console.log('AUTO_APPROVE_URL_ACCESS:', process.env.AUTO_APPROVE_URL_ACCESS);
console.log('AUTO_APPROVE_OTHER_REQUESTS:', process.env.AUTO_APPROVE_OTHER_REQUESTS);

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
