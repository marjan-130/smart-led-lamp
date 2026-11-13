# Smart LED Lamp — веб-контролер (ESP32 + MQTT)

React + Tailwind CSS + `mqtt` (WebSocket) — керування розумною LED-лампою.

## Запуск

```bash
npm install
npm run dev
```

Відкрийте адресу з терміналу (за замовчуванням http://localhost:5173).
Збірка для продакшну: `npm run build` (результат у `dist/`).

## Структура (усі файли в одній папці)

```
index.html
main.jsx
index.css
App.jsx
package.json
vite.config.js
tailwind.config.js
postcss.config.js
```

## MQTT

- Брокер: `wss://broker.hivemq.com:8884/mqtt`
- Команди: `chopyk/smart_lamp/set`
- Телеметрія: `chopyk/smart_lamp/state`

## Що налаштувати під прошивку (на початку App.jsx)

- `buildHuePayload(hue)` — формат команди кольору (за замовчуванням `{"hue": 0..360}`).
- `LDR_MAX` — максимум датчика світла (за замовчуванням 4095).
- `LOCK_MS` — вікно "Last Event Wins" після локальної команди (1500 мс).
