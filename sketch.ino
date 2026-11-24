#include <Adafruit_NeoPixel.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// Піни та апаратні налаштування ESP32
#define LED_PIN          16      // GPIO16 - Лінія даних адресної стрічки WS2812B
#define NUM_LEDS         30      // Кількість світлодіодів у стрічці

#define SOUND_PIN        18      // GPIO18 - Кнопка 1: Імітація хлопу (INT)
#define MODE_BUTTON_PIN  19      // GPIO19 - Кнопка 2: Перемикач режимів (INT)
#define MUTE_BUTTON_PIN  21      // GPIO21 - Кнопка 3: Увімк/Вимк звуку (INT)
#define TIMER_BUTTON_PIN 22      // GPIO22 - Кнопка 4: Запуск таймера сну (INT)

#define BUZZER_PIN       23      // GPIO23 - П'єзодинамік (Звуковий фідбек)
#define POT_PIN          34      // GPIO34 - Потенціометр (Аналоговий вхід ADC1_CH6)
#define LDR_PIN          35      // GPIO35 - Датчик світла LDR (Аналоговий вхід ADC1_CH7)

// Наскільки треба повернути потенціометр, щоб він "перебив" колір із додатку
#define POT_RELEASE_DELTA 150

// Налаштування Wi-Fi та MQTT хмари
const char* ssid         = "Wokwi-GUEST";       // Для Wokwi (на реальному роутері вказуєм свій SSID)
const char* password     = "";                  // Пароль Wi-Fi

const char* mqtt_server  = "broker.hivemq.com"; // Публічний безкоштовний брокер
const int   mqtt_port    = 1883;

// Унікальні топіки для твого проєкту
const char* topic_set   = "chopyk/smart_lamp/set";   // Сюди додаток надсилає команди
const char* topic_state = "chopyk/smart_lamp/state"; // Сюди ESP32 надсилає статус

WiFiClient espClient;
PubSubClient client(espClient);
Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);

// Глобальні змінні стану (volatile для безпечної роботи з ISR)
volatile unsigned long lastClapTime = 0;
volatile unsigned long lastModeTime = 0;
volatile unsigned long lastMuteTime = 0;
volatile unsigned long lastTimerBtnTime = 0;

volatile bool systemState = false;         // false = Початковий стан ВИМКНЕНО
volatile uint8_t currentMode = 0;           // 0: Статика, 1: Веселка, 2: Нічник, 3: Пульсація
volatile bool stateChangedFlag = false;    // Прапорець запуску хвилі ввімкнення/вимкнення

// Змінні керування звуковим фідбеком (Buzzer Mute toggle)
volatile bool buzzerEnabled = true;        // Прапорець звукового фідбеку
volatile unsigned long buzzerStartTime = 0;
volatile bool isBuzzerActive = false;

// Змінні програмного таймера сну
volatile unsigned long timerStartTime = 0;
volatile unsigned long timerDurationMs = 0;
volatile bool isTimerActive = false;
volatile bool timerTriggeredFlag = false;  // Прапорець для безпечного виклику analogRead у loop

// Керування з додатку (змінюються лише в MQTT callback, не в ISR)
bool webHueActive = false;                 // true = колір задано з додатку
uint16_t webHueDeg = 190;                  // Відтінок з додатку, 0..360
int potBaseline = 0;                       // Положення потенціометра в момент команди з додатку
bool manualBrightness = false;             // true = яскравість задано з додатку (інакше авто за LDR)
uint8_t webBrightness = 255;               // Яскравість з додатку, 0..255

unsigned long lastMqttReportTime = 0;

/* ------------------------------------------------------------------ */
/*  Допоміжні функції кольору та яскравості                           */
/* ------------------------------------------------------------------ */

// Відтінок у градусах (0..360). Додаток має пріоритет, доки потенціометр
// не повернули на помітну величину: тоді "виграє" остання дія.
uint16_t getHueDeg(int potRaw) {
  if (webHueActive) {
    if (abs(potRaw - potBaseline) > POT_RELEASE_DELTA) {
      webHueActive = false;
    } else {
      return webHueDeg;
    }
  }
  return map(potRaw, 0, 4095, 0, 360);
}

// Градуси -> 16-бітний відтінок для ColorHSV
uint16_t hueDegTo16(uint16_t deg) {
  return (uint16_t)((uint32_t)deg * 65535UL / 360UL);
}

// Яскравість: ручна з додатку або авто за датчиком світла
uint8_t getBrightness(int ldrRaw) {
  if (manualBrightness) return webBrightness;
  return map(ldrRaw, 0, 4095, 30, 255);
}

// Обробники апаратних переривань (ESP32 IRAM_ATTR)

// 1. Переривання: Подвійний хлоп (GPIO18)
void IRAM_ATTR soundISR() {
  unsigned long currentTime = millis();
  unsigned long timeDiff = currentTime - lastClapTime;

  if (timeDiff >= 100 && timeDiff <= 600) {
    systemState = !systemState;
    stateChangedFlag = true;
    
    if (buzzerEnabled) {
      digitalWrite(BUZZER_PIN, HIGH);
      buzzerStartTime = currentTime;
      isBuzzerActive = true;
    }
  }
  lastClapTime = currentTime;
}

// 2. Переривання: Зміна режиму (GPIO19)
void IRAM_ATTR modeButtonISR() {
  unsigned long currentTime = millis();
  if (currentTime - lastModeTime > 200) { // Антидребезг 200 мс
    currentMode = (currentMode + 1) % 4;
    
    if (buzzerEnabled) {
      digitalWrite(BUZZER_PIN, HIGH);
      buzzerStartTime = currentTime;
      isBuzzerActive = true;
    }
    lastModeTime = currentTime;
  }
}

// 3. Переривання: Увімкнення/Вимкнення звуку Mute (GPIO21)
void IRAM_ATTR muteButtonISR() {
  unsigned long currentTime = millis();
  if (currentTime - lastMuteTime > 250) {
    buzzerEnabled = !buzzerEnabled;
    
    if (buzzerEnabled) {
      digitalWrite(BUZZER_PIN, HIGH);
      buzzerStartTime = currentTime;
      isBuzzerActive = true;
    }
    lastMuteTime = currentTime;
  }
}

// 4. Переривання: Активація таймера сну (GPIO22)
void IRAM_ATTR timerButtonISR() {
  unsigned long currentTime = millis();
  if (currentTime - lastTimerBtnTime > 300) {
    // Встановлюємо прапорець, зчитування POT_PIN виконується у loop
    timerTriggeredFlag = true;

    if (buzzerEnabled) {
      digitalWrite(BUZZER_PIN, HIGH);
      buzzerStartTime = currentTime;
      isBuzzerActive = true;
    }
    lastTimerBtnTime = currentTime;
  }
}

// Анімація поступового вмикання хвилею
void animateWaveOn() {
  int ldrRaw = analogRead(LDR_PIN);
  uint8_t brightness = getBrightness(ldrRaw);

  int potRaw = analogRead(POT_PIN);
  uint16_t hue = hueDegTo16(getHueDeg(potRaw));

  for (int i = 0; i < NUM_LEDS; i++) {
    strip.setPixelColor(i, strip.ColorHSV(hue, 255, brightness));
    strip.show();
    delay(20);
  }
}

// Анімація поступового вимикання хвилею
void animateWaveOff() {
  for (int i = 0; i < NUM_LEDS; i++) {
    strip.setPixelColor(i, strip.Color(0, 0, 0));
    strip.show();
    delay(20);
  }
  strip.clear();
  strip.show();
}

// Допоміжна функція генерації кольорів градієнта (веселка)
uint32_t Wheel(byte WheelPos) {
  WheelPos = 255 - WheelPos;
  if (WheelPos < 85) return strip.Color(255 - WheelPos * 3, 0, WheelPos * 3);
  if (WheelPos < 170) {
    WheelPos -= 85;
    return strip.Color(0, WheelPos * 3, 255 - WheelPos * 3);
  }
  WheelPos -= 170;
  return strip.Color(WheelPos * 3, 255 - WheelPos * 3, 0);
}

// Обробка вхідних MQTT повідомлень з додатку
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, payload, length);

  if (error) {
    Serial.print("JSON parsing failed: ");
    Serial.println(error.c_str());
    return;
  }

  // Обробка поля "state" (true/false)
  if (doc.containsKey("state")) {
    bool newState = doc["state"];
    if (newState != systemState) {
      systemState = newState;
      stateChangedFlag = true;
    }
  }

  // Обробка поля "mode" (0..3)
  if (doc.containsKey("mode")) {
    int m = doc["mode"];
    if (m >= 0 && m <= 3) {
      currentMode = m;
    }
  }

  // Обробка поля "hue" (0..360 градусів) - колір з додатку
  if (doc.containsKey("hue")) {
    int h = doc["hue"];
    webHueDeg = constrain(h, 0, 360);
    webHueActive = true;
    potBaseline = analogRead(POT_PIN); // запам'ятовуємо, де зараз потенціометр
  }

  // Обробка поля "brightness" (0..255) - ручна яскравість з додатку
  if (doc.containsKey("brightness")) {
    int b = doc["brightness"];
    webBrightness = constrain(b, 0, 255);
    manualBrightness = true;
  }

  // Повернення до автояскравості за датчиком світла
  if (doc.containsKey("auto_brightness")) {
    manualBrightness = !doc["auto_brightness"].as<bool>();
  }

  // Обробка поля "mute" (true/false)
  if (doc.containsKey("mute")) {
    buzzerEnabled = !doc["mute"].as<bool>();
  }

  // Обробка поля "timer" (хвилини)
  if (doc.containsKey("timer")) {
    int tMin = doc["timer"];
    if (tMin > 0) {
      timerDurationMs = tMin * 60000UL;
      timerStartTime = millis();
      isTimerActive = true;
    } else {
      isTimerActive = false;
    }
  }

  Serial.println("MQTT Command executed!");
}

// Підключення до MQTT брокера
void reconnectMQTT() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection...");
    String clientId = "ESP32Client-Chopyk-" + String(random(0xffff), HEX);
    
    if (client.connect(clientId.c_str())) {
      Serial.println("connected!");
      client.subscribe(topic_set); // Підписуємося на топік команд
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}

// Ініціалізація периферії та апаратних ресурсів
void setup() {
  Serial.begin(115200);

  pinMode(SOUND_PIN, INPUT_PULLUP);
  pinMode(MODE_BUTTON_PIN, INPUT_PULLUP);
  pinMode(MUTE_BUTTON_PIN, INPUT_PULLUP);
  pinMode(TIMER_BUTTON_PIN, INPUT_PULLUP);
  
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LDR_PIN, INPUT);
  pinMode(POT_PIN, INPUT);

  digitalWrite(BUZZER_PIN, LOW);

  // Реєстрація обробників апаратних переривань
  attachInterrupt(digitalPinToInterrupt(SOUND_PIN), soundISR, FALLING);
  attachInterrupt(digitalPinToInterrupt(MODE_BUTTON_PIN), modeButtonISR, FALLING);
  attachInterrupt(digitalPinToInterrupt(MUTE_BUTTON_PIN), muteButtonISR, FALLING);
  attachInterrupt(digitalPinToInterrupt(TIMER_BUTTON_PIN), timerButtonISR, FALLING);

  strip.begin();
  strip.clear();
  strip.show();

  // Підключення до Wi-Fi
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected! IP: " + WiFi.localIP().toString());

  // Налаштування MQTT
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);
}

// Головний цикл роботи системи
void loop() {
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop(); // Обов'язкова підтримка сесії MQTT

  unsigned long currentMillis = millis();

  // 1. Автоматичне вимкнення пищалки через 50 мс
  if (isBuzzerActive && (currentMillis - buzzerStartTime >= 50)) {
    digitalWrite(BUZZER_PIN, LOW);
    isBuzzerActive = false;
  }

  // 2. Безпечна обробка натискання кнопки таймера (зчитування ADC у loop)
  if (timerTriggeredFlag) {
    timerTriggeredFlag = false;
    int potRaw = analogRead(POT_PIN);
    int timerMinutes = 15;
    if (potRaw > 2700) timerMinutes = 60;
    else if (potRaw > 1300) timerMinutes = 30;

    timerDurationMs = timerMinutes * 60000UL;
    timerStartTime = currentMillis;
    isTimerActive = true;
  }

  // 3. Обробка спрацювання таймера сну
  if (isTimerActive && (currentMillis - timerStartTime >= timerDurationMs)) {
    systemState = false;
    stateChangedFlag = true;
    isTimerActive = false;
    Serial.println("Sleep Timer Expired: Turning OFF via Wave...");
  }

  // 4. Запуск анімації зміни стану системи (Вмикання / Вимикання)
  if (stateChangedFlag) {
    stateChangedFlag = false;
    if (systemState) {
      animateWaveOn();
    } else {
      animateWaveOff();
    }
  }

  // 5. Відправка телеметрії в хмару кожні 3 секунди
  if (currentMillis - lastMqttReportTime > 3000) {
    lastMqttReportTime = currentMillis;

    int ldrNow = analogRead(LDR_PIN);
    int potNow = analogRead(POT_PIN);

    StaticJsonDocument<192> doc;
    doc["state"] = systemState;
    doc["mode"] = currentMode;
    doc["ldr"] = ldrNow;
    doc["timer_active"] = isTimerActive;
    doc["hue"] = getHueDeg(potNow);
    doc["brightness"] = getBrightness(ldrNow);

    char buffer[192];
    serializeJson(doc, buffer);
    client.publish(topic_state, buffer);
  }

  // Якщо система вимкнена — виходимо з циклу
  if (!systemState) {
    delay(20);
    return;
  }

  // 6. Зчитування сенсорів: LDR для авто-яскравості та потенціометр для керування
  int ldrRaw = analogRead(LDR_PIN);
  uint8_t brightness = getBrightness(ldrRaw);

  int potRaw = analogRead(POT_PIN);

  static unsigned long lastAnimationUpdate = 0;

  // 7. Рендеринг активного режиму
  switch (currentMode) {
    case 0: // Статика: колір з додатку або з потенціометра
      {
        uint16_t hue = hueDegTo16(getHueDeg(potRaw));
        for (int i = 0; i < NUM_LEDS; i++) {
          strip.setPixelColor(i, strip.ColorHSV(hue, 255, brightness));
        }
      }
      break;

    case 1: // Веселка: Регулювання швидкості переливання потенціометром
      if (currentMillis - lastAnimationUpdate > map(potRaw, 0, 4095, 5, 50)) {
        static uint8_t rainbowHue = 0;
        rainbowHue++;
        for (int i = 0; i < NUM_LEDS; i++) {
          uint32_t c = Wheel((i * 256 / NUM_LEDS + rainbowHue) & 255);
          uint8_t r = (uint8_t)(c >> 16) * brightness / 255;
          uint8_t g = (uint8_t)(c >> 8) * brightness / 255;
          uint8_t b = (uint8_t)c * brightness / 255;
          strip.setPixelColor(i, strip.Color(r, g, b));
        }
        lastAnimationUpdate = currentMillis;
      }
      break;

    case 2: // Нічник: Тепле світло 2700K
      {
        uint8_t r = 255 * brightness / 255;
        uint8_t g = 147 * brightness / 255;
        uint8_t b = 41 * brightness / 255;
        for (int i = 0; i < NUM_LEDS; i++) {
          strip.setPixelColor(i, strip.Color(r, g, b));
        }
      }
      break;

    case 3: // Пульсація: Дихаючий ефект зі швидкістю від потенціометра
      {
        uint16_t speed = map(potRaw, 0, 4095, 10, 50);
        float pulse = (exp(sin(millis() / 1000.0 * speed)) - 0.36787944) * 108.0;
        int pulseVal = constrain((int)pulse, 0, 255);
        uint8_t pulseBrightness = map(pulseVal, 0, 255, 10, max((int)brightness, 11));
        
        for (int i = 0; i < NUM_LEDS; i++) {
          strip.setPixelColor(i, strip.ColorHSV(43690, 255, pulseBrightness));
        }
      }
      break;
  }

  strip.show();
  delay(15);
}
