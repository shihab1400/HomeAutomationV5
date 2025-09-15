
showMainPage();
// ========== Enhanced Authentication System with ESP32 + Timer Functionality ==========
const MQTT_BROKER = "wss://1494998b45794f319ee0dae0290dab09.s1.eu.hivemq.cloud:8884/mqtt";
const MQTT_USER = "smartMultiPlug";
const MQTT_PASS = "smartMultiPlug1221";

// MQTT Topics
const controlTopics = {
   1: "home/relay1",
   2: "home/relay2",
   3: "home/relay3",
   4: "home/relay4",
};
const statusTopic = "home/status";
const authTopic = "home/auth";
const authResponseTopic = "home/auth/response";
const credentialsChangeTopic = "home/credentials/change";
const credentialsResponseTopic = "home/credentials/response";

// New Timer Topics
const timerSetTopic = "home/timer/set";
const timerCancelTopic = "home/timer/cancel";
const timerStatusTopic = "home/timer/status";

// New Sensor Topics
const sensorDataTopic = "home/sensor/data";
const alertStatusTopic = "home/alert/status";

// Authentication state
let isAuthenticated = false;
let authenticationInProgress = false;
let credentialsChangeInProgress = false;
let pendingAuthCallbacks = new Map();
let authSessionCounter = 0;

// System states
let switchStates = { 1: false, 2: false, 3: false, 4: false };
let timerStates = { 1: null, 2: null, 3: null, 4: null };
let sensorData = { temperature: null, humidity: null, lastUpdate: null };
let buzzerAlert = false;
let client = null;
let sequentialOperationInProgress = false;

// ========== Utility Functions ==========
function generateSessionId() {
   return `session_${Date.now()}_${++authSessionCounter}`;
}

function setCookie(name, value, days) {
   const expires = new Date();
   expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
   document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/`;
}

function getCookie(name) {
   const nameEQ = name + "=";
   const ca = document.cookie.split(";");
   for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) === " ") c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
   }
   return null;
}

function deleteCookie(name) {
   document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
}

// Format timer display (seconds to HH:MM:SS)
function formatTime(seconds) {
   const hours = Math.floor(seconds / 3600);
   const minutes = Math.floor((seconds % 3600) / 60);
   const secs = seconds % 60;
   return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
}

// ========== Sensor Data Functions ==========
function updateSensorDisplay(temperature, humidity) {
   const tempElement = document.getElementById("temperatureValue");
   const humidityElement = document.getElementById("humidityValue");
   const sensorStatus = document.getElementById("sensorStatus");
   const sensorIcon = document.getElementById("sensorStatusIcon");

   if (temperature !== null && humidity !== null) {
      tempElement.textContent = temperature.toFixed(1);
      humidityElement.textContent = humidity.toFixed(1);
      sensorStatus.textContent = "Online";
      sensorIcon.className = "status-icon sensor";

      sensorData = {
         temperature: temperature,
         humidity: humidity,
         lastUpdate: Date.now(),
      };
   } else {
      tempElement.textContent = "--";
      humidityElement.textContent = "--";
      sensorStatus.textContent = "Error";
      sensorIcon.className = "status-icon alert";
   }
}

function updateAlertStatus(active, temperature, threshold = 40) {
   const alertBanner = document.getElementById("alertBanner");
   const alertMessage = document.getElementById("alertMessage");
   const sensorIcon = document.getElementById("sensorStatusIcon");

   buzzerAlert = active;

   if (active) {
      alertBanner.classList.add("active");
      alertMessage.textContent = `Temperature ${temperature.toFixed(
         1
      )}°C exceeds threshold of ${threshold}°C. Buzzer activated!`;
      sensorIcon.className = "status-icon alert";
   } else {
      alertBanner.classList.remove("active");
      if (temperature !== null) {
         sensorIcon.className = "status-icon sensor";
      }
   }
}

// ========== MQTT Authentication Functions ==========
function authenticateWithESP32(username, password) {
   return new Promise((resolve, reject) => {
      if (!client || !client.connected) {
         reject("MQTT not connected");
         return;
      }

      const sessionId = generateSessionId();
      const authData = {
         username: username,
         password: password,
         sessionId: sessionId,
      };

      pendingAuthCallbacks.set(sessionId, { resolve, reject });

      setTimeout(() => {
         if (pendingAuthCallbacks.has(sessionId)) {
            pendingAuthCallbacks.delete(sessionId);
            reject("Authentication timeout");
         }
      }, 10000);

      client.publish(authTopic, JSON.stringify(authData));
      console.log("Authentication request sent to ESP32");
   });
}

function changeCredentialsOnESP32(currentPassword, newUsername, newPassword) {
   return new Promise((resolve, reject) => {
      if (!client || !client.connected) {
         reject("MQTT not connected");
         return;
      }

      const sessionId = generateSessionId();
      const credentialsData = {
         currentPassword: currentPassword,
         newUsername: newUsername,
         newPassword: newPassword,
         sessionId: sessionId,
      };

      pendingAuthCallbacks.set(sessionId, { resolve, reject });

      setTimeout(() => {
         if (pendingAuthCallbacks.has(sessionId)) {
            pendingAuthCallbacks.delete(sessionId);
            reject("Credentials change timeout");
         }
      }, 10000);

      client.publish(credentialsChangeTopic, JSON.stringify(credentialsData));
      console.log("Credentials change request sent to ESP32");
   });
}

// ========== Timer Functions ==========
function setTimer(relayNumber) {
   if (!isAuthenticated || !client || !client.connected) return;

   const hours = parseInt(document.getElementById(`hours-${relayNumber}`).value) || 0;
   const minutes = parseInt(document.getElementById(`minutes-${relayNumber}`).value) || 0;
   const seconds = parseInt(document.getElementById(`seconds-${relayNumber}`).value) || 0;

   const totalSeconds = hours * 3600 + minutes * 60 + seconds;

   if (totalSeconds === 0) {
      alert("Please set a valid timer duration");
      return;
   }

   if (totalSeconds > 86400) {
      // 24 hours max
      alert("Timer cannot exceed 24 hours");
      return;
   }

   // Send timer command to ESP32
   const timerData = {
      relay: relayNumber,
      duration: totalSeconds,
      action: "set",
   };

   client.publish(timerSetTopic, JSON.stringify(timerData));
   console.log(`Timer set for relay ${relayNumber}: ${totalSeconds} seconds`);

   // Update UI immediately
   timerStates[relayNumber] = {
      remaining: totalSeconds,
      total: totalSeconds,
   };

   updateTimerUI(relayNumber, totalSeconds);

   // Clear input fields
   document.getElementById(`hours-${relayNumber}`).value = "";
   document.getElementById(`minutes-${relayNumber}`).value = "";
   document.getElementById(`seconds-${relayNumber}`).value = "";
}

function cancelTimer(relayNumber) {
   if (!isAuthenticated || !client || !client.connected) return;

   // Send cancel command to ESP32
   const timerData = {
      relay: relayNumber,
      action: "cancel",
   };

   client.publish(timerCancelTopic, JSON.stringify(timerData));
   console.log(`Timer cancelled for relay ${relayNumber}`);

   // Update UI
   timerStates[relayNumber] = null;
   hideTimerUI(relayNumber);
}

function cancelAllTimers() {
   if (!isAuthenticated || !client || !client.connected) return;

   for (let i = 1; i <= 4; i++) {
      if (timerStates[i]) {
         cancelTimer(i);
      }
   }
}

function updateTimerUI(relayNumber, remainingSeconds) {
   const timerDisplay = document.getElementById(`timer-display-${relayNumber}`);
   const cancelBtn = document.getElementById(`cancel-btn-${relayNumber}`);
   const switchCard = document.getElementById(`switch${relayNumber}`);

   timerDisplay.textContent = `Timer: ${formatTime(remainingSeconds)}`;
   timerDisplay.classList.remove("hidden");
   cancelBtn.classList.remove("hidden");

   // Add timer styling to card
   switchCard.classList.add("timer-active");

   // Add warning styling if less than 1 minute remaining
   if (remainingSeconds <= 60) {
      timerDisplay.classList.add("ending");
   } else {
      timerDisplay.classList.remove("ending");
   }

   updateTimerCount();
}

function hideTimerUI(relayNumber) {
   const timerDisplay = document.getElementById(`timer-display-${relayNumber}`);
   const cancelBtn = document.getElementById(`cancel-btn-${relayNumber}`);
   const switchCard = document.getElementById(`switch${relayNumber}`);

   timerDisplay.classList.add("hidden");
   cancelBtn.classList.add("hidden");
   switchCard.classList.remove("timer-active");
   timerDisplay.classList.remove("ending");

   updateTimerCount();
}

function updateTimerCount() {
   const activeTimers = Object.values(timerStates).filter((t) => t !== null).length;
   const timerCountEl = document.getElementById("timerCount");
   if (timerCountEl) {
      timerCountEl.textContent = `${activeTimers} running`;
   }
}

// ========== MQTT Connection and Setup ==========
function initializeMQTT() {
   const options = {
      username: MQTT_USER,
      password: MQTT_PASS,
      clean: true,
      reconnectPeriod: 2000,
   };

   client = mqtt.connect(MQTT_BROKER, options);

   client.on("connect", () => {
      console.log("Connected to HiveMQ Cloud");
      document.getElementById("connectionStatus").className = "connection-indicator connected";
      document.getElementById("connectionStatus").textContent = "● Connected";
      if (document.getElementById("brokerStatus")) {
         document.getElementById("brokerStatus").textContent = "Online";
      }

      // Subscribe to all topics including timer topics
      client.subscribe(statusTopic);
      client.subscribe(authResponseTopic);
      client.subscribe(credentialsResponseTopic);
      client.subscribe(timerStatusTopic);
      client.subscribe(sensorDataTopic);
      client.subscribe(alertStatusTopic);
      console.log("Subscribed to MQTT topics including sensor data");
   });

   client.on("error", (err) => {
      console.error("MQTT Error:", err);
   });

   client.on("reconnect", () => {
      console.log("Reconnecting...");
      document.getElementById("connectionStatus").className = "connection-indicator disconnected";
      document.getElementById("connectionStatus").textContent = "● Reconnecting...";
   });

   client.on("message", (topic, message) => {
      console.log(`Message from ${topic}: ${message.toString()}`);
      handleMQTTMessage(topic, message.toString());
   });
}

function handleMQTTMessage(topic, message) {
   if (topic === authResponseTopic) {
      handleAuthResponse(message);
   } else if (topic === credentialsResponseTopic) {
      handleCredentialsChangeResponse(message);
   } else if (topic === timerStatusTopic) {
      handleTimerStatusMessage(message);
   } else if (topic === sensorDataTopic) {
      handleSensorDataMessage(message);
   } else if (topic === alertStatusTopic) {
      handleAlertStatusMessage(message);
   } else if (topic === statusTopic) {
      handleStatusMessage(message);
   }
}

function handleSensorDataMessage(message) {
   try {
      const sensorInfo = JSON.parse(message);
      updateSensorDisplay(sensorInfo.temperature, sensorInfo.humidity);
      console.log(
         `Sensor data received - Temperature: ${sensorInfo.temperature}°C, Humidity: ${sensorInfo.humidity}%`
      );
   } catch (error) {
      console.error("Error parsing sensor data:", error);
      updateSensorDisplay(null, null);
   }
}

function handleAlertStatusMessage(message) {
   try {
      const alertInfo = JSON.parse(message);
      updateAlertStatus(alertInfo.buzzerActive, alertInfo.temperature, alertInfo.threshold);
      console.log(
         `Alert status: ${alertInfo.buzzerActive ? "ACTIVE" : "INACTIVE"} - Temperature: ${
            alertInfo.temperature
         }°C`
      );
   } catch (error) {
      console.error("Error parsing alert status:", error);
   }
}

function handleTimerStatusMessage(message) {
   try {
      const timerData = JSON.parse(message);
      const relayNumber = timerData.relay;

      if (timerData.status === "running") {
         // Timer is running - update UI
         timerStates[relayNumber] = {
            remaining: timerData.remaining,
            total: timerData.total,
         };
         updateTimerUI(relayNumber, timerData.remaining);
      } else if (timerData.status === "finished" || timerData.status === "cancelled") {
         // Timer finished or was cancelled - hide UI
         timerStates[relayNumber] = null;
         hideTimerUI(relayNumber);

         if (timerData.status === "finished") {
            // Relay should be OFF now, update the switch UI
            updateSwitchUI(relayNumber, false);
         }
      }
   } catch (error) {
      console.error("Error parsing timer status:", error);
   }
}

function handleAuthResponse(message) {
   try {
      const response = JSON.parse(message);
      const sessionId = response.sessionId;

      if (pendingAuthCallbacks.has(sessionId)) {
         const { resolve, reject } = pendingAuthCallbacks.get(sessionId);
         pendingAuthCallbacks.delete(sessionId);

         if (response.success) {
            resolve(response);
         } else {
            reject(response.message || "Authentication failed");
         }
      }
   } catch (error) {
      console.error("Error parsing auth response:", error);
   }
}

function handleCredentialsChangeResponse(message) {
   try {
      const response = JSON.parse(message);
      const sessionId = response.sessionId;

      if (pendingAuthCallbacks.has(sessionId)) {
         const { resolve, reject } = pendingAuthCallbacks.get(sessionId);
         pendingAuthCallbacks.delete(sessionId);

         if (response.success) {
            resolve(response);
         } else {
            reject(response.message || "Credentials change failed");
         }
      }
   } catch (error) {
      console.error("Error parsing credentials change response:", error);
   }
}

function handleStatusMessage(message) {
   if (message.includes("Living Room")) {
      updateSwitchUI(1, message.includes("ON"));
   } else if (message.includes("Bedroom Fan")) {
      updateSwitchUI(2, message.includes("ON"));
   } else if (message.includes("Kitchen")) {
      updateSwitchUI(3, message.includes("ON"));
   } else if (message.includes("Garden")) {
      updateSwitchUI(4, message.includes("ON"));
   }
   updateActiveCount();
   updateLastUpdateTime();
}

// ========== Form Handlers (Original Authentication Code) ==========
document.getElementById("loginForm").addEventListener("submit", async function (e) {
   e.preventDefault();

   if (authenticationInProgress) return;

   const username = document.getElementById("username").value;
   const password = document.getElementById("password").value;
   const rememberMe = document.getElementById("rememberMe").checked;
   const errorDiv = document.getElementById("loginError");
   const warningDiv = document.getElementById("loginWarning");
   const loginBtn = document.getElementById("loginBtn");

   errorDiv.textContent = "";
   warningDiv.textContent = "";

   if (!client || !client.connected) {
      warningDiv.textContent = "Connecting to system... Please wait.";
      if (!client) {
         initializeMQTT();
      }
      setTimeout(() => {
         if (client && client.connected) {
            warningDiv.textContent = "Connected! Please try logging in again.";
         } else {
            errorDiv.textContent = "Cannot connect to system. Please check your connection.";
         }
      }, 3000);
      return;
   }

   authenticationInProgress = true;
   loginBtn.innerHTML = '<div class="spinner"></div>Authenticating...';
   loginBtn.disabled = true;

   try {
      await authenticateWithESP32(username, password);
      isAuthenticated = true;
      if (rememberMe) {
         setCookie("rememberMe", "true", 30);
      }
      showMainPage();
   } catch (error) {
      errorDiv.textContent = error;
      console.error("Authentication failed:", error);
   } finally {
      authenticationInProgress = false;
      loginBtn.innerHTML = "🔒 Sign In";
      loginBtn.disabled = false;
   }
});

document.getElementById("changePasswordForm").addEventListener("submit", async function (e) {
   e.preventDefault();

   if (credentialsChangeInProgress) return;

   const currentPassword = document.getElementById("currentPassword").value;
   const newUsername = document.getElementById("newUsername").value;
   const newPassword = document.getElementById("newPassword").value;
   const confirmPassword = document.getElementById("confirmPassword").value;
   const errorDiv = document.getElementById("changePasswordError");
   const successDiv = document.getElementById("changePasswordSuccess");
   const warningDiv = document.getElementById("changePasswordWarning");
   const changeBtn = document.getElementById("changePasswordBtn");

   errorDiv.textContent = "";
   successDiv.textContent = "";
   warningDiv.textContent = "";

   if (newPassword !== confirmPassword) {
      errorDiv.textContent = "New passwords do not match";
      return;
   }

   if (newPassword.length < 3) {
      errorDiv.textContent = "Password must be at least 3 characters long";
      return;
   }

   if (!client || !client.connected) {
      errorDiv.textContent = "Not connected to system. Please try again.";
      return;
   }

   credentialsChangeInProgress = true;
   changeBtn.innerHTML = '<div class="spinner"></div>Updating...';
   changeBtn.disabled = true;

   try {
      await changeCredentialsOnESP32(currentPassword, newUsername, newPassword);
      successDiv.textContent = "Credentials updated successfully on ESP32!";
      document.getElementById("changePasswordForm").reset();

      setTimeout(() => {
         showMainPage();
      }, 2000);
   } catch (error) {
      errorDiv.textContent = error;
      console.error("Credentials change failed:", error);
   } finally {
      credentialsChangeInProgress = false;
      changeBtn.innerHTML = "💾 Update";
      changeBtn.disabled = false;
   }
});

// ========== Page Navigation ==========
function checkRememberedUser() {
   const remembered = getCookie("rememberMe");
   return remembered === "true";
}

function showLoginPage() {
   document.getElementById("loginPage").classList.remove("hidden");
   document.getElementById("mainPage").classList.add("hidden");
   document.getElementById("changePasswordPage").classList.add("hidden");
   isAuthenticated = false;
}

function showMainPage() {
   document.getElementById("loginPage").classList.add("hidden");
   document.getElementById("mainPage").classList.remove("hidden");
   document.getElementById("changePasswordPage").classList.add("hidden");

   if (!client || !client.connected) {
      initializeMQTT();
   }
}

function showChangePassword() {
   if (!isAuthenticated) {
      showLoginPage();
      return;
   }
   document.getElementById("loginPage").classList.add("hidden");
   document.getElementById("mainPage").classList.add("hidden");
   document.getElementById("changePasswordPage").classList.remove("hidden");
}

function logout() {
   deleteCookie("rememberMe");
   isAuthenticated = false;
   showLoginPage();
   if (client && client.connected) {
      client.end();
   }
}

// ========== Relay Control Functions (Enhanced with Timer Awareness) ==========
function toggleSwitch(switchNumber) {
   if (sequentialOperationInProgress || !isAuthenticated) return;

   // If timer is running, ask for confirmation
   if (timerStates[switchNumber]) {
      const confirm = window.confirm(
         "This relay has an active timer. Manual toggle will cancel the timer. Continue?"
      );
      if (!confirm) return;

      // Cancel the timer first
      cancelTimer(switchNumber);
   }

   const newState = !switchStates[switchNumber];
   const payload = newState ? "ON" : "OFF";
   client.publish(controlTopics[switchNumber], payload);
   updateSwitchUI(switchNumber, newState);
   updateActiveCount();
   updateLastUpdateTime();
}

function updateSwitchUI(switchNumber, isOn) {
   switchStates[switchNumber] = isOn;
   const switchCard = document.getElementById(`switch${switchNumber}`);
   const toggle = switchCard.querySelector(".switch-toggle");
   const statusDot = switchCard.querySelector(".status-dot");
   const statusText = switchCard.querySelector(".switch-status span");

   if (isOn) {
      toggle.classList.add("active");
      statusDot.classList.add("on");
      statusText.textContent = "ON";
      switchCard.classList.add("active");
   } else {
      toggle.classList.remove("active");
      statusDot.classList.remove("on");
      statusText.textContent = "OFF";
      switchCard.classList.remove("active");
   }
}

async function allSwitchesOn() {
   if (sequentialOperationInProgress || !isAuthenticated) return;

   sequentialOperationInProgress = true;
   const allOnBtn = document.getElementById("allOnBtn");
   const allOffBtn = document.getElementById("allOffBtn");

   allOnBtn.disabled = true;
   allOffBtn.disabled = true;
   allOnBtn.textContent = "⏳ Turning ON...";

   for (let i = 1; i <= 4; i++) {
      client.publish(controlTopics[i], "ON");
      updateSwitchUI(i, true);
      updateActiveCount();
      updateLastUpdateTime();

      if (i < 4) {
         await new Promise((resolve) => setTimeout(resolve, 300));
      }
   }

   allOnBtn.disabled = false;
   allOffBtn.disabled = false;
   allOnBtn.textContent = "⚡ Turn All ON";
   sequentialOperationInProgress = false;
}

async function allSwitchesOff() {
   if (sequentialOperationInProgress || !isAuthenticated) return;

   sequentialOperationInProgress = true;
   const allOnBtn = document.getElementById("allOnBtn");
   const allOffBtn = document.getElementById("allOffBtn");

   allOnBtn.disabled = true;
   allOffBtn.disabled = true;
   allOffBtn.textContent = "⏳ Turning OFF...";

   for (let i = 1; i <= 4; i++) {
      client.publish(controlTopics[i], "OFF");
      updateSwitchUI(i, false);
      updateActiveCount();
      updateLastUpdateTime();

      if (i < 4) {
         await new Promise((resolve) => setTimeout(resolve, 300));
      }
   }

   allOnBtn.disabled = false;
   allOffBtn.disabled = false;
   allOffBtn.textContent = "🔌 Turn All OFF";
   sequentialOperationInProgress = false;
}

function updateActiveCount() {
   const activeCount = Object.values(switchStates).filter((s) => s).length;
   const activeCountEl = document.getElementById("activeCount");
   if (activeCountEl) {
      activeCountEl.textContent = `${activeCount} of 4`;
   }
}

function updateLastUpdateTime() {
   const now = new Date();
   const timeString = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
   });
   const lastUpdateEl = document.getElementById("lastUpdate");
   if (lastUpdateEl) {
      lastUpdateEl.textContent = timeString;
   }
}

// ========== Theme Management ==========
function setTheme(theme) {
   document.body.setAttribute("data-theme", theme);
   document.querySelectorAll(".theme-toggle-btn").forEach((btn) => btn.classList.remove("active"));
   event.target.classList.add("active");
   setCookie("theme", theme, 365);
}

function loadTheme() {
   const savedTheme = getCookie("theme") || "light";
   document.body.setAttribute("data-theme", savedTheme);
   const activeBtn =
      savedTheme === "light"
         ? document.querySelector(".theme-toggle-btn[onclick=\"setTheme('light')\"]")
         : document.querySelector(".theme-toggle-btn[onclick=\"setTheme('dark')\"]");
   if (activeBtn) {
      document
         .querySelectorAll(".theme-toggle-btn")
         .forEach((btn) => btn.classList.remove("active"));
      activeBtn.classList.add("active");
   }
}

// ========== Application Initialization ==========
document.addEventListener("DOMContentLoaded", function () {
   console.log(
      "Initializing Smart Home Control System with ESP32 Authentication and Timer Functionality"
   );

   loadTheme();
   initializeMQTT();

   if (checkRememberedUser()) {
      document.getElementById("loginWarning").textContent =
         "Remembered session found. Please authenticate with ESP32 to continue.";
   }

   showLoginPage();
   updateActiveCount();
   updateTimerCount();
   updateLastUpdateTime();
   updateSensorDisplay(null, null); // Initialize with no data
});

