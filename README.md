# Codex Chat

Prosty, prywatny chatbot z wyborem **Astry**, **Sola** i mocy rozumowania. Lista mocy pochodzi z Codexa na Macu Studio; jeśli konto nie udostępnia któregoś modelu, bramka go nie zastępuje innym.

Logowanie do strony jest osobne. Codex pozostaje zalogowany przez ChatGPT na Macu Studio. Rozmowy zużywają wspólny limit tego konta Codex; bramka nie używa klucza API ani nie przełącza się na rozliczenie API. Nie tworzy dodatkowych limitów.

```
Telefon / komputer → HTTPS → hasło bramki → Mac Studio → zalogowany Codex
```

Kod i statyczny interfejs mogą być na GitHubie. **GitHub Pages nie uruchamia Codexa** — serwer Node i tunel HTTPS działają na Macu Studio. Ten sam interfejs jest także dostępny bezpośrednio pod adresem HTTPS tunelu. To najprostsza ścieżka używania bramki.

## Uruchomienie na Macu Studio

Wymagane: Node.js 22 lub nowszy i Codex zalogowany przez ChatGPT, na tym samym użytkowniku macOS. Nie potrzeba `npm install`.

W katalogu pobranego repozytorium:

```bash
npm run password
npm start
```

Pierwsze polecenie pyta dwukrotnie o hasło bez wyświetlania znaków. Hasło musi mieć co najmniej 8 znaków. Otwórz [http://127.0.0.1:8787](http://127.0.0.1:8787), zaloguj się hasłem bramki i wybierz model oraz moc. Login strony nie zmienia loginu Codexa.

Gdy Codex nie jest w `PATH`, wskaż plik wykonywalny:

```bash
CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex npm start
```

### Praca w tle

Po ustawieniu hasła:

```bash
npm run install:macos
```

Instalator rozpoznaje bieżący Node i Codexa, sprawdza login ChatGPT i tworzy wyłącznie własny LaunchAgent `com.codex-chat.gateway`. Nie kopiuje tokenów logowania. Usługa działa w sesji tego użytkownika i uruchamia się po jego zalogowaniu. Mac Studio musi pozostawać włączony, połączony z siecią i dostępny; skrypt nie zmienia ustawień usypiania.

Stan i logi:

```bash
launchctl print gui/$(id -u)/com.codex-chat.gateway
tail -n 60 .data/logs/gateway-error.log
```

Po zmianie kodu uruchom ponownie tylko tę usługę:

```bash
launchctl kickstart -k gui/$(id -u)/com.codex-chat.gateway
```

`npm run uninstall:macos` usuwa własne LaunchAgenty bramki i tunelu, zachowując dane rozmów oraz login Codexa. Nie zatrzymuje innych zadań Codexa.

## HTTPS z dowolnego miejsca

Do krótkiego testu można użyć tunelu bez własnej domeny:

```bash
brew install cloudflared
npm run https
```

Otwórz adres `https://…trycloudflare.com` wypisany przez `cloudflared`. Zdalny dostęp działa dopiero, gdy serwer bramki i tunel rzeczywiście działają. Tymczasowy adres zmienia się po ponownym uruchomieniu tunelu i przestaje działać po jego zatrzymaniu. Cloudflare przeznacza Quick Tunnels do testów i nie obsługuje w nich SSE. [Dokumentacja Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

Bramka przesyła odpowiedzi jako NDJSON, więc nie wymaga SSE. Aby tymczasowy tunel działał w tle także po zakończeniu połączenia SSH:

```bash
npm run install:https
```

Własny LaunchAgent `com.codex-chat.tunnel` utrzymuje proces `cloudflared` w sesji użytkownika. Odczytaj aktualny adres z `.data/gateway-url.json`; po restarcie procesu może się zmienić. Jeżeli `cloudflared` nie jest w `PATH`, instalator sprawdza również `~/.local/bin/cloudflared`, albo przyjmuje `--cloudflared-bin /pełna/ścieżka/cloudflared`. Ten skrypt nie zmienia konfiguracji ani innych tuneli Cloudflare.

### Stały adres

Dla stałego HTTPS użyj własnej domeny w Cloudflare i nazwanego tunelu. Na Macu Studio:

```bash
cloudflared tunnel login
cloudflared tunnel create codex-chat
cloudflared tunnel route dns codex-chat chat.twoja-domena.pl
```

Polecenie `create` wypisze UUID tunelu i ścieżkę pliku uprawnień. W swoim pliku konfiguracji, poza repozytorium, ustaw:

```yaml
tunnel: UUID_Z_POLECENIA_CREATE
credentials-file: /pełna/ścieżka/.cloudflared/UUID_Z_POLECENIA_CREATE.json
ingress:
  - hostname: chat.twoja-domena.pl
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Uruchom tunel, wskazując własną ścieżkę:

```bash
npm run https -- --config /pełna/ścieżka/codex-chat.yml --named codex-chat
```

Do pracy po restarcie nazwany tunel trzeba również uruchamiać jako usługę Cloudflare; `install:https` służy tylko tunelowi tymczasowemu. Konfiguracja i uprawnienia Cloudflare zostają na Macu Studio, poza GitHubem. [Dokumentacja nazwanych tuneli](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/).

## Strona na GitHub Pages

Repozytorium zawiera workflow publikujący **tylko `public/`**. W `Settings → Pages → Build and deployment` wybierz `GitHub Actions`, a następnie uruchom workflow albo wypchnij zmianę `public/` na `main`. [Dokumentacja GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Na ekranie logowania strony Pages podaj adres HTTPS bramki na Macu Studio. Można też ustawić ten publiczny adres w `public/config.js`. Nie wpisuj tam hasła ani żadnych tokenów. Domyślnie serwer dopuszcza origin `https://jakiesluchawki.github.io`; dla innego konta lub własnej domeny ustaw dokładny origin bez ścieżki:

```bash
ALLOWED_ORIGINS=https://twoje-konto.github.io npm start
```

Przy instalowaniu usługi:

```bash
npm run install:macos -- --allowed-origins https://twoje-konto.github.io
```

Kilka originów rozdziel przecinkiem. Bezpośrednie otwarcie bramki pod jej własnym adresem HTTPS nie wymaga dodatkowego originu Pages.

## Dane i konfiguracja

Rozmowy i skrót hasła są w `.data/`, wykluczonym z Gita. Hasło jest zapisane jako skrót `scrypt` z losową solą; `access.json` ma uprawnienia `600`, a katalog danych `700`. Każdy, kto zna hasło bramki, korzysta z tego samego zbioru rozmów i limitu Codexa. To bramka dla jednego właściciela, bez odrębnych kont użytkowników.

Zmiana hasła: `npm run password`. Nowe logowania użyją go od razu; restart serwera kończy aktywne sesje. Bramka działa jako chatbot z wyłączonymi narzędziami wykonawczymi, przeglądarką i integracjami Codexa.

| Ustawienie | Domyślnie |
| --- | --- |
| `PORT` | `8787`; serwer nasłuchuje tylko na `127.0.0.1` |
| `CODEX_BIN` | Codex z `PATH` lub z aplikacji Codex/ChatGPT |
| `CHAT_DATA_DIR` | `.data/` w katalogu repozytorium |
| `ALLOWED_ORIGINS` | `https://jakiesluchawki.github.io` oraz własny origin bramki |
| `CLOUDFLARED_BIN` | `cloudflared` z `PATH`, dla skryptu HTTPS |

`npm run password -- --stdin` pozwala przekazać hasło przez jawny potok bez argumentu zawierającego hasło. Do zwykłej konfiguracji używaj interaktywnego pytania. Jeśli zmieniasz `CHAT_DATA_DIR`, ustaw tę samą ścieżkę podczas konfiguracji hasła, instalacji i uruchamiania; nie publikuj tego katalogu.

Sprawdzenie aplikacji: `npm test`.
