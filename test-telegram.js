// Test script to send message to Telegram from Claude
const vscode = require('vscode');

async function testSendToTelegram() {
    const result = await vscode.commands.executeCommand(
        'telegram-claude.sendToActiveChat',
        '🤖 Bu mesajı Claude kendisi gönderdi! Test başarılı! 🎉'
    );
    console.log('Message sent:', result);
}

testSendToTelegram();
