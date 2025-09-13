#include <WiFi.h>
#include <PubSubClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Wire.h>

// ========== WiFi Credentials ==========
const char* ssid = "Turn around and BEND to connect";
const char* password = "agetakade";

// ========== HiveMQ Cloud Broker ==========
const char* mqtt_server = "1494998b45794f319ee0dae0290dab09.s1.eu.hivemq.cloud";
const int mqtt_port = 8883;
const char* mqtt_user = "smartMultiPlug";
const char* mqtt_pass = "smartMultiPlug1221";

// ========== Authentication ==========
Preferences preferences;
String stored_username = "admin";
String stored_password = "admin";

// DHT22 Configuration
#define DHT_PIN 2
#define DHT_TYPE DHT22
DHT dht(DHT_PIN, DHT_TYPE);

// Buzzer Configuration
#define BUZZER_PIN 5

// Temperature Alert Configuration
const float TEMP_THRESHOLD = 35.0;  // Temperature threshold in Celsius
bool buzzerActive = false;

// ========== Timer Structure ==========
struct RelayTimer {
  bool active;                    // Is timer currently running?
  unsigned long startTime;        // When timer was started (millis())
  unsigned long duration;         // Timer duration in seconds
  int relayNumber;               // Which relay (1-4)
  bool relayWasOn;              // Was relay on when timer started?
};

// Relay pins (connected to 4-channel relay module)
const int relayPins[4] = {4, 19, 21, 22};
const char* relayNames[4] = {"Living Room Lights", "Bedroom Fan", "Kitchen Appliances", "Garden Lights"};
bool relayStates[4] = {false, false, false, false};

// Timer instances for each relay
RelayTimer timers[4] = {
  {false, 0, 0, 1, false},
  {false, 0, 0, 2, false},
  {false, 0, 0, 3, false},
  {false, 0, 0, 4, false}
};

// ========== Sensor Data Structure ==========
struct SensorData {
  float temperature;
  float humidity;
  bool isValid;
  unsigned long lastUpdate;
};
SensorData currentSensorData = {0.0, 0.0, false, 0};

// WiFi + MQTT client
WiFiClientSecure espClient;
PubSubClient client(espClient);

// MQTT Topics
const char* controlTopics[4] = {"home/relay1", "home/relay2", "home/relay3", "home/relay4"};
const char* statusTopic = "home/status";
const char* authTopic = "home/auth";
const char* authResponseTopic = "home/auth/response";
const char* credentialsChangeTopic = "home/credentials/change";
const char* credentialsResponseTopic = "home/credentials/response";

// Timer Topics
const char* timerSetTopic = "home/timer/set";
const char* timerCancelTopic = "home/timer/cancel";
const char* timerStatusTopic = "home/timer/status";

// New Topics for Sensor Data and Alerts
const char* sensorDataTopic = "home/sensor/data";
const char* alertStatusTopic = "home/alert/status";

// Timing intervals
const unsigned long TIMER_UPDATE_INTERVAL = 1000;        // 1 second
const unsigned long SENSOR_READ_INTERVAL = 1000;         // 2 seconds for sensor readings
const unsigned long LCD_UPDATE_INTERVAL = 1000;          // 2 second for LCD updates
const unsigned long MQTT_SENSOR_INTERVAL = 1000;         // 5 seconds for MQTT sensor updates

unsigned long lastTimerUpdate = 0;
unsigned long lastSensorRead = 0;
unsigned long lastLcdUpdate = 0;
unsigned long lastMqttSensorUpdate = 0;

// ====== Load Stored Credentials ======
void loadCredentials() {
  preferences.begin("auth", false);
  stored_username = preferences.getString("username", "admin");
  stored_password = preferences.getString("password", "admin");
  preferences.end();
  
  Serial.println("Loaded credentials from storage:");
  Serial.println("Username: " + stored_username);
  Serial.println("Password: " + stored_password);
}

// ====== Save Credentials ======
void saveCredentials(String username, String password) {
  preferences.begin("auth", false);
  preferences.putString("username", username);
  preferences.putString("password", password);
  preferences.end();
  
  stored_username = username;
  stored_password = password;
  
  Serial.println("Credentials saved successfully:");
  Serial.println("New Username: " + username);
  Serial.println("New Password: " + password);
}

// ====== DHT22 Sensor Functions ======
void initializeSensor() {
  dht.begin();
  Serial.println("DHT22 sensor initialized");
  
  // Wait for first reading
  delay(2000);
  readSensorData();
}

void readSensorData() {
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();
  
  // Check if readings are valid
  if (!isnan(temp) && !isnan(hum)) {
    currentSensorData.temperature = temp;
    currentSensorData.humidity = hum;
    currentSensorData.isValid = true;
    currentSensorData.lastUpdate = millis();
    
    Serial.printf("Sensor Data - Temperature: %.1f°C, Humidity: %.1f%%\n", temp, hum);
    
    // Check temperature threshold for buzzer alert
    checkTemperatureAlert(temp);
  } else {
    Serial.println("Failed to read from DHT22 sensor");
    currentSensorData.isValid = false;
  }
}

void checkTemperatureAlert(float temperature) {
  if (temperature > TEMP_THRESHOLD && !buzzerActive) {
    // Temperature exceeded threshold - activate buzzer
    buzzerActive = true;
    digitalWrite(BUZZER_PIN, HIGH);
    Serial.printf("Temperature alert activated! Temperature: %.1f°C (Threshold: %.1f°C)\n", 
                  temperature, TEMP_THRESHOLD);
    
    // Send alert status to MQTT
    publishAlertStatus(true, temperature);
    
  } else if (temperature <= TEMP_THRESHOLD && buzzerActive) {
    // Temperature back to normal - deactivate buzzer
    buzzerActive = false;
    digitalWrite(BUZZER_PIN, LOW);
    Serial.printf("Temperature alert deactivated. Temperature: %.1f°C\n", temperature);
    
    // Send alert status to MQTT
    publishAlertStatus(false, temperature);
  }
}

void publishAlertStatus(bool active, float temperature) {
  DynamicJsonDocument doc(256);
  doc["buzzerActive"] = active;
  doc["temperature"] = temperature;
  doc["threshold"] = TEMP_THRESHOLD;
  doc["timestamp"] = millis();
  
  String jsonString;
  serializeJson(doc, jsonString);
  client.publish(alertStatusTopic, jsonString.c_str());
}

void publishSensorData() {
  if (!currentSensorData.isValid) return;
  
  DynamicJsonDocument doc(256);
  doc["temperature"] = currentSensorData.temperature;
  doc["humidity"] = currentSensorData.humidity;
  doc["timestamp"] = currentSensorData.lastUpdate;
  doc["buzzerActive"] = buzzerActive;
  
  String jsonString;
  serializeJson(doc, jsonString);
  client.publish(sensorDataTopic, jsonString.c_str());
}

// ====== Buzzer Functions ======
void initializeBuzzer() {
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  Serial.println("Buzzer initialized on pin " + String(BUZZER_PIN));
}

// ====== Timer Management Functions ======

// Set a timer for a specific relay
void setRelayTimer(int relayNumber, unsigned long durationSeconds) {
  if (relayNumber < 1 || relayNumber > 4) return;
  
  int index = relayNumber - 1;
  
  // Cancel existing timer if running
  if (timers[index].active) {
    Serial.println("Replacing existing timer for relay " + String(relayNumber));
  }
  
  // Set up new timer
  timers[index].active = true;
  timers[index].startTime = millis();
  timers[index].duration = durationSeconds;
  timers[index].relayNumber = relayNumber;
  timers[index].relayWasOn = relayStates[index];
  
  // Turn relay ON when timer starts (as requested)
  if (!relayStates[index]) {
    relayStates[index] = true;
    digitalWrite(relayPins[index], HIGH);
    
    // Send status update
    String statusMsg = String(relayNames[index]) + " is ON (Timer Set)";
    client.publish(statusTopic, statusMsg.c_str());
  }
  
  Serial.printf("Timer set for relay %d: %lu seconds\n", relayNumber, durationSeconds);
  
  // Send initial timer status
  sendTimerStatus(relayNumber);
}

// Cancel a timer for a specific relay
void cancelRelayTimer(int relayNumber) {
  if (relayNumber < 1 || relayNumber > 4) return;
  
  int index = relayNumber - 1;
  
  if (timers[index].active) {
    timers[index].active = false;
    Serial.println("Timer cancelled for relay " + String(relayNumber));
    
    // Send cancelled status
    DynamicJsonDocument doc(256);
    doc["relay"] = relayNumber;
    doc["status"] = "cancelled";
    doc["remaining"] = 0;
    doc["total"] = 0;
    
    String jsonString;
    serializeJson(doc, jsonString);
    client.publish(timerStatusTopic, jsonString.c_str());
  }
}

// Check if any timers have expired and handle them
void processTimers() {
  unsigned long currentTime = millis();
  
  for (int i = 0; i < 4; i++) {
    if (timers[i].active) {
      unsigned long elapsedSeconds = (currentTime - timers[i].startTime) / 1000;
      
      if (elapsedSeconds >= timers[i].duration) {
        // Timer expired - turn relay OFF
        int relayNumber = timers[i].relayNumber;
        
        Serial.printf("Timer expired for relay %d - turning OFF\n", relayNumber);
        
        // Turn relay OFF
        relayStates[i] = false;
        digitalWrite(relayPins[i], LOW);
        
        // Send status update
        String statusMsg = String(relayNames[i]) + " is OFF (Timer Finished)";
        client.publish(statusTopic, statusMsg.c_str());
        
        // Send timer finished status
        DynamicJsonDocument doc(256);
        doc["relay"] = relayNumber;
        doc["status"] = "finished";
        doc["remaining"] = 0;
        doc["total"] = timers[i].duration;
        
        String jsonString;
        serializeJson(doc, jsonString);
        client.publish(timerStatusTopic, jsonString.c_str());
        
        // Deactivate timer
        timers[i].active = false;
      }
    }
  }
}

// Send timer status update for a specific relay
void sendTimerStatus(int relayNumber) {
  if (relayNumber < 1 || relayNumber > 4) return;
  
  int index = relayNumber - 1;
  
  if (timers[index].active) {
    unsigned long currentTime = millis();
    unsigned long elapsedSeconds = (currentTime - timers[index].startTime) / 1000;
    unsigned long remainingSeconds = 0;
    
    if (elapsedSeconds < timers[index].duration) {
      remainingSeconds = timers[index].duration - elapsedSeconds;
    }
    
    DynamicJsonDocument doc(256);
    doc["relay"] = relayNumber;
    doc["status"] = "running";
    doc["remaining"] = remainingSeconds;
    doc["total"] = timers[index].duration;
    
    String jsonString;
    serializeJson(doc, jsonString);
    client.publish(timerStatusTopic, jsonString.c_str());
  }
}

// Send status updates for all active timers
void sendAllTimerStatus() {
  for (int i = 1; i <= 4; i++) {
    if (timers[i-1].active) {
      sendTimerStatus(i);
    }
  }
}

// ====== Handle Timer Set Request ======
void handleTimerSetRequest(String payload) {
  DynamicJsonDocument doc(512);
  deserializeJson(doc, payload);
  
  int relay = doc["relay"];
  unsigned long duration = doc["duration"];
  String action = doc["action"];
  
  Serial.printf("Timer set request: Relay %d, Duration %lu seconds\n", relay, duration);
  
  if (action == "set" && relay >= 1 && relay <= 4 && duration > 0) {
    setRelayTimer(relay, duration);
  }
}

// ====== Handle Timer Cancel Request ======
void handleTimerCancelRequest(String payload) {
  DynamicJsonDocument doc(512);
  deserializeJson(doc, payload);
  
  int relay = doc["relay"];
  String action = doc["action"];
  
  Serial.printf("Timer cancel request: Relay %d\n", relay);
  
  if (action == "cancel" && relay >= 1 && relay <= 4) {
    cancelRelayTimer(relay);
  }
}

// ====== Handle Authentication Request ======
void handleAuthRequest(String payload) {
  DynamicJsonDocument doc(1024);
  deserializeJson(doc, payload);
  
  String username = doc["username"];
  String password = doc["password"];
  String sessionId = doc["sessionId"];
  
  Serial.println("Authentication request received:");
  Serial.println("Username: " + username);
  Serial.println("Password: " + password);
  Serial.println("Session ID: " + sessionId);
  
  DynamicJsonDocument response(512);
  response["sessionId"] = sessionId;
  
  if (username == stored_username && password == stored_password) {
    response["success"] = true;
    response["message"] = "Authentication successful";
    Serial.println("Authentication: SUCCESS");
  } else {
    response["success"] = false;
    response["message"] = "Invalid username or password";
    Serial.println("Authentication: FAILED");
  }
  
  String responseString;
  serializeJson(response, responseString);
  client.publish(authResponseTopic, responseString.c_str());
}

// ====== Handle Credentials Change Request ======
void handleCredentialsChange(String payload) {
  DynamicJsonDocument doc(1024);
  deserializeJson(doc, payload);
  
  String currentPassword = doc["currentPassword"];
  String newUsername = doc["newUsername"];
  String newPassword = doc["newPassword"];
  String sessionId = doc["sessionId"];
  
  Serial.println("Credentials change request received:");
  Serial.println("Current Password: " + currentPassword);
  Serial.println("New Username: " + newUsername);
  Serial.println("New Password: " + newPassword);
  Serial.println("Session ID: " + sessionId);
  
  DynamicJsonDocument response(512);
  response["sessionId"] = sessionId;
  
  if (currentPassword == stored_password) {
    saveCredentials(newUsername, newPassword);
    response["success"] = true;
    response["message"] = "Credentials updated successfully";
    Serial.println("Credentials change: SUCCESS");
  } else {
    response["success"] = false;
    response["message"] = "Current password is incorrect";
    Serial.println("Credentials change: FAILED - Wrong current password");
  }
  
  String responseString;
  serializeJson(response, responseString);
  client.publish(credentialsResponseTopic, responseString.c_str());
}

// ====== MQTT Callback (Enhanced with Timer Support) ======
void callback(char* topic, byte* payload, unsigned int length) {
  String message;
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.printf("Message on [%s]: %s\n", topic, message.c_str());

  // Handle authentication requests
  if (String(topic) == authTopic) {
    handleAuthRequest(message);
    return;
  }
  
  // Handle credentials change requests
  if (String(topic) == credentialsChangeTopic) {
    handleCredentialsChange(message);
    return;
  }

  // Handle timer set requests
  if (String(topic) == timerSetTopic) {
    handleTimerSetRequest(message);
    return;
  }

  // Handle timer cancel requests
  if (String(topic) == timerCancelTopic) {
    handleTimerCancelRequest(message);
    return;
  }

  // Handle relay control (enhanced with timer awareness)
  for (int i = 0; i < 4; i++) {
    if (String(topic) == controlTopics[i]) {
      int relayNumber = i + 1;
      
      // If there's an active timer, cancel it when manual control is used
      if (timers[i].active) {
        Serial.printf("Manual control detected for relay %d - cancelling active timer\n", relayNumber);
        cancelRelayTimer(relayNumber);
      }
      
      bool newState = (message == "ON");
      relayStates[i] = newState;
      
      digitalWrite(relayPins[i], newState ? HIGH : LOW);
      
      Serial.printf("Relay %d (%s) -> %s (Pin %d set to %s)\n", 
                    relayNumber, relayNames[i], 
                    newState ? "ON" : "OFF",
                    relayPins[i],
                    newState ? "HIGH" : "LOW");

      String statusMsg = String(relayNames[i]) + " is " + (newState ? "ON" : "OFF");
      client.publish(statusTopic, statusMsg.c_str());
    }
  }
}

// ====== Reconnect to MQTT ======
void reconnect() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection...");
    if (client.connect("ESP32Client", mqtt_user, mqtt_pass)) {
      Serial.println("connected");
      
      // Subscribe to all topics including timer topics
      for (int i = 0; i < 4; i++) {
        client.subscribe(controlTopics[i]);
      }
      client.subscribe(authTopic);
      client.subscribe(credentialsChangeTopic);
      client.subscribe(timerSetTopic);
      client.subscribe(timerCancelTopic);
      
      // Send initial status for all relays
      for (int i = 0; i < 4; i++) {
        String statusMsg = String(relayNames[i]) + " is " + (relayStates[i] ? "ON" : "OFF");
        client.publish(statusTopic, statusMsg.c_str());
        delay(100);
      }
      
      // Send status for any active timers
      sendAllTimerStatus();
      
    } else {
      Serial.print("failed, rc=");
      Serial.println(client.state());
      delay(5000);
    }
  }
}

// ====== Setup ======
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== ESP32 Smart Home Controller with Authentication & Timer Functionality ===");

  // Initialize hardware components
  initializeSensor();
  initializeBuzzer();

  // Initialize relay pins
  for (int i = 0; i < 4; i++) {
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], LOW);
    Serial.printf("Relay %d (%s) initialized - Pin %d set to LOW (NC contact closed)\n", 
                  i + 1, relayNames[i], relayPins[i]);
  }

  // Initialize all timers as inactive
  for (int i = 0; i < 4; i++) {
    timers[i].active = false;
  }

  // Connect WiFi
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // Secure connection (TLS)
  espClient.setInsecure();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);

  Serial.println("- Temperature Alert Buzzer (Threshold: " + String(TEMP_THRESHOLD) + "°C)");
  Serial.println("- Authentication & Timer functionality");
  Serial.println("Current stored credentials:");
  Serial.println("Username: " + stored_username);
  Serial.println("Password: " + stored_password);
}

// ====== Main Loop (Enhanced with Timer Processing) ======
void loop() {
  unsigned long currentTime = millis();
  
  // Handle MQTT connection
  if (!client.connected()) {
    reconnect();
  }
  client.loop();
  
  // Read sensor data at specified interval
  if (currentTime - lastSensorRead >= SENSOR_READ_INTERVAL) {
    readSensorData();
    lastSensorRead = currentTime;
  }
  
  // Publish sensor data to MQTT at specified interval
  if (currentTime - lastMqttSensorUpdate >= MQTT_SENSOR_INTERVAL) {
    publishSensorData();
    lastMqttSensorUpdate = currentTime;
  }
  
  // Process timers - check for expired timers
  processTimers();
  
  // Send timer status updates periodically (every second)
  if (currentTime - lastTimerUpdate >= TIMER_UPDATE_INTERVAL) {
    sendAllTimerStatus();
    lastTimerUpdate = currentTime;
  }
  
  // Heartbeat message every 30 seconds
  static unsigned long lastHeartbeat = 0;
  if (currentTime - lastHeartbeat > 30000) {
    String heartbeatMsg = "ESP32 Online - Auth, Timer, DHT22, LCD & Buzzer Enabled";
    client.publish("home/heartbeat", heartbeatMsg.c_str());
    lastHeartbeat = currentTime;
  }
  
  // Small delay to prevent excessive CPU usage
  delay(10);
}