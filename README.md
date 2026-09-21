# Codex Chat

Prosty, prywatny chatbot z wyborem **Astry**, **Sola** i mocy rozumowania. Lista mocy pochodzi z Codexa na Macu Studio; jeśli konto nie udostępnia któregoś modelu, bramka go nie zastępuje innym.

Logowanie do strony jest osobne. Codex pozostaje zalogowany przez ChatGPT na Macu Studio. Rozmowy zużywają wspólny limit tego konta Codex; bramka nie używa klucza API ani nie przełącza się na rozliczenie API. Bramka nie zwiększa puli konta Codex.

Bramka ma **niezależny tygodniowy licznik wyłącznie własnych rozmów**. Domyślna pula wynosi **5 000 000 umownych jednostek**. Inne zadania Codexa nie pomniejszają tego licznika. Pełne limity konta nadal obowiązują i mogą osobno zablokować odpowiedzi po stronie Codexa.

Rzeczywiste odczyty tokenów własnych rozmów są przeliczane lokalnie: wejście bez cache × 1, wejście z cache × 0,1, wyjście × 4; następnie Astra × 2 albo Sol × 1. To pomocnicze wagi do kalibracji, a nie udokumentowany sposób rozliczania Codexa. Pula 5 000 000 jest orientacyjną korektą po pomiarze: pierwotne 500 000 wyczerpało się, gdy konto nadal pokazywało 99% pozostałego limitu. Ten współdzielony i zaokrąglony odczyt nie potwierdza dokładnych 10% ukrytej puli Codexa.

`CHAT_WEEKLY_BUDGET_UNITS` pozwala dostroić pulę na podstawie pomiarów własnych rozmów; nowa wartość obowiązuje od kolejnego tygodniowego okna. Stan w `.data/budget.json` przetrwa restart serwera. Kolejne tygodniowe okno odnawia własną pulę bramki. Zużycie innych zadań nie zmienia jej automatycznie.

Do świadomej korekty bieżącego okresu użyj po zatrzymaniu usługi `npm run budget -- 5000000 --data-dir /ścieżka/do/.data`, a następnie uruchom ją ponownie. Skrypt tworzy prywatną kopię licznika i zachowuje dotychczasowe zużycie, historię naliczeń oraz datę odnowienia. Sama zmiana wartości domyślnej w kodzie nie zwiększa puli trwającego okresu.

Codex może podać zużycie dopiero po zakończeniu odpowiedzi. Bramka blokuje kolejne wiadomości po wyczerpaniu puli, ale ostatnia odpowiedź może przekroczyć pozostały budżet. To orientacyjny ogranicznik użycia, a nie gwarancja zachowania dokładnie 90% limitu konta.

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

### Repozytorium na dysku zewnętrznym

Jeżeli `launchd` zgłasza `Unable to open stdout path` i `Operation not permitted` dla ścieżki `/Volumes/…`, kod usługi i jej dane można umieścić w wewnętrznym katalogu aplikacji. Repozytorium źródłowe zostaje na dysku zewnętrznym. Przenieś wyłącznie `.data/` tej bramki do nowego katalogu danych, zachowując istniejący stan limitu i rozmowy, a następnie użyj:

```bash
npm run install:macos -- --runtime-dir "$HOME/Library/Application Support/CodexChat" --data-dir "$HOME/Library/Application Support/CodexChat/.data"
npm run install:https -- --runtime-dir "$HOME/Library/Application Support/CodexChat" --data-dir "$HOME/Library/Application Support/CodexChat/.data"
```

`--runtime-dir` kopiuje kod aplikacji, a `--data-dir` wskazuje jej dane i logi. Dotychczasowy `CODEX_HOME` jest zachowany; login Codexa pozostaje w swojej dotychczasowej lokalizacji. Przy aktualizacji kodu powtórz instalację z tymi samymi flagami albo zaktualizuj kopię kodu w katalogu usługi, zachowując `.data/`.

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

Jeśli `gh` jest już zalogowany na tym użytkowniku i ma zapis do repozytorium, tunel może sam aktualizować adres bramki na stronie Pages:

```bash
npm run install:https -- --github-repo twoje-konto/codex-chat --gh-bin /pełna/ścieżka/gh
```

Publikator zmienia tylko `public/config.js` w podanym repozytorium `codex-chat` na gałęzi `main`. Nie kopiuje credentiali. Po zmianie adresu workflow publikuje Pages; zanim zakończy się publikacja, strona może jeszcze wskazywać poprzedni adres. Błąd dostępu do GitHuba nie zatrzymuje tunelu; wtedy aktualny adres trzeba wpisać ręcznie. Stały adres domeny nadal wymaga nazwanego tunelu.

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
| `CHAT_GITHUB_REPO` | opcjonalne `twoje-konto/codex-chat` do aktualizacji adresu na Pages |
| `GH_BIN` | `gh` z `PATH`, dla opcjonalnej publikacji adresu |

`npm run password -- --stdin` pozwala przekazać hasło przez jawny potok bez argumentu zawierającego hasło. Do zwykłej konfiguracji używaj interaktywnego pytania. Jeśli zmieniasz `CHAT_DATA_DIR`, ustaw tę samą ścieżkę podczas konfiguracji hasła, instalacji i uruchamiania; nie publikuj tego katalogu.

Sprawdzenie aplikacji: `npm test`.
