# Telegram Claude Bridge - Kurulum Rehberi

Bu rehber, Telegram Claude Bridge extension'ını kurup çalıştırmanız için adım adım talimatlar içerir.

## Önkoşullar

- Node.js (v20 veya üzeri)
- VS Code
- Telegram hesabı
- Anthropic API anahtarı (Claude entegrasyonu için)

## Adım 1: Telegram Botu Oluşturma

1. Telegram'ı açın ve [@BotFather](https://t.me/botfather) botunu bulun
2. `/newbot` komutunu gönderin
3. Bot için bir isim seçin (örn: "My Claude Bot")
4. Bot için bir kullanıcı adı seçin (örn: "my_claude_bot")
5. BotFather size bir token verecek. Bu tokeni kopyalayın ve güvenli bir yerde saklayın
   - Token şu formatta olacak: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

## Adım 2: Extension'ı Geliştirme Modunda Çalıştırma

1. Bu projeyi VS Code'da açın
2. Terminal'de şu komutları çalıştırın:
   ```bash
   npm install
   npm run compile
   ```
3. F5 tuşuna basarak Extension Development Host penceresini açın
4. Yeni açılan VS Code penceresinde extension çalışır durumda olacak

## Adım 3: Bot Token'ını Yapılandırma

1. Extension Development Host penceresinde Command Palette'i açın (`Cmd+Shift+P` veya `Ctrl+Shift+P`)
2. `Telegram: Configure Bot Token` komutunu çalıştırın
3. BotFather'dan aldığınız tokeni yapıştırın
4. Enter'a basın

## Adım 4: Botu Başlatma

1. Command Palette'i açın
2. `Telegram: Start Bot` komutunu çalıştırın
3. "Telegram bot is now running!" mesajını görmelisiniz

## Adım 5: Chat ID'nizi Alma

1. Telegram'da oluşturduğunuz botunuzu bulun
2. Bota `/start` mesajı gönderin
3. Bot size chat ID'nizi gösterecek (örn: 123456789)
4. Bu ID'yi kopyalayın

## Adım 6: Chat ID'nizi Whitelist'e Ekleme

1. VS Code'da Settings'i açın (`Cmd+,` veya `Ctrl+,`)
2. Arama kutusuna `telegramClaude.allowedChatIds` yazın
3. "Edit in settings.json" bağlantısına tıklayın
4. Chat ID'nizi array içine ekleyin:
   ```json
   {
       "telegramClaude.allowedChatIds": [123456789]
   }
   ```
5. Dosyayı kaydedin

## Adım 7: Claude API Anahtarını Yapılandırma (İsteğe bağlı ama önerilen)

1. [console.anthropic.com](https://console.anthropic.com) adresine gidin
2. API Keys bölümünden yeni bir anahtar oluşturun
3. VS Code'da Command Palette'i açın
4. `Telegram: Configure Claude API Key` komutunu çalıştırın
5. API anahtarınızı yapıştırın
6. Enter'a basın

## Test Etme

1. Telegram'da botunuza herhangi bir mesaj gönderin
2. Claude integration aktifse, bot size otomatik olarak Claude'un cevabını gönderecek
3. VS Code'un Output panelinde (View → Output → "Telegram Claude" seçin) logları görebilirsiniz

## Faydalı Komutlar

### Telegram'da

- `/start` - Bot bilgilerini ve chat ID'nizi gösterir
- `/clear` - Konuşma geçmişini temizler

### VS Code'da

- `Telegram: Start Bot` - Botu başlatır
- `Telegram: Stop Bot` - Botu durdurur
- `Telegram: Send Message` - Tüm kayıtlı chat ID'lerine mesaj gönderir
- `Telegram: Clear Conversation History` - Tüm konuşma geçmişlerini temizler

## Ayarlar

VS Code settings.json dosyanızda yapılandırabileceğiniz seçenekler:

```json
{
    // Telegram Bot API Token
    "telegramClaude.botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",

    // İzin verilen chat ID'leri (güvenlik için)
    "telegramClaude.allowedChatIds": [123456789],

    // VS Code başlangıcında botu otomatik başlat
    "telegramClaude.autoStart": false,

    // Anthropic API anahtarı
    "telegramClaude.anthropicApiKey": "sk-ant-xxxxx",

    // Otomatik Claude cevaplarını etkinleştir
    "telegramClaude.enableClaudeIntegration": true
}
```

## Sorun Giderme

### Bot yanıt vermiyor

1. Bot'un çalıştığından emin olun: `Telegram: Start Bot`
2. Bot token'ının doğru olduğunu kontrol edin
3. Chat ID'nizin allowedChatIds listesinde olduğundan emin olun
4. Output panelini kontrol edin: View → Output → "Telegram Claude"

### Claude yanıt vermiyor

1. Anthropic API anahtarınızın yapılandırıldığını kontrol edin
2. `enableClaudeIntegration` ayarının aktif olduğundan emin olun
3. API kredinizin olduğunu kontrol edin
4. Output panelinde hata mesajlarını kontrol edin

### Extension Development Host ile ilgili sorunlar

1. Extension'ı yeniden yükleyin: Command Palette → `Developer: Reload Window`
2. `npm run compile` komutunu tekrar çalıştırın
3. VS Code'u kapatıp tekrar açın

## Production'a Dağıtma

Extension'ı paketleyip yüklemek için:

```bash
# vsce'yi global olarak yükleyin
npm install -g @vscode/vsce

# Extension'ı paketleyin
vsce package

# Oluşan .vsix dosyasını yükleyin
code --install-extension vscode-telegram-claude-0.0.1.vsix
```

## Güvenlik Notları

- Bot token ve API anahtarlarınızı asla paylaşmayın
- `.gitignore` dosyasının `.env` dosyalarını içerdiğinden emin olun
- Sadece güvendiğiniz chat ID'lerini allowedChatIds listesine ekleyin
- API anahtarlarınızı düzenli olarak yenileyin

## Destek

Sorularınız veya sorunlarınız için:
- GitHub Issues bölümünde konu açın
- Projenin README.md dosyasını inceleyin
