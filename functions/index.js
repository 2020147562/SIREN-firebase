const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const FormData = require("form-data");
const axios = require("axios");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const { SpeechClient } = require("@google-cloud/speech");
const { file: tmpFile } = require("tmp-promise");
const { exec } = require("child_process");
const { onRequest } = require("firebase-functions/v2/https");

admin.initializeApp();
const app = express();
const speechClient = new SpeechClient();

// JSON body parsing
app.use(express.json());

// Gmail credentials from env
const gmailUser = process.env.GMAIL_USER;
const gmailPass = process.env.GMAIL_PASS;

async function convertAacToWav(aacBuffer) {
  const input = await tmpFile({ postfix: ".aac" });
  const output = await tmpFile({ postfix: ".wav" });
  fs.writeFileSync(input.path, aacBuffer);

  functions.logger.info("🎵 Starting FFmpeg conversion", { input: input.path });

  await new Promise((resolve, reject) => {
    ffmpeg(input.path)
      .toFormat("wav")
      .on("error", err => reject(err))
      .on("end", () => resolve())
      .save(output.path);
  });

  return output;
}

async function getSampleRate(wavPath) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of csv=p=0 ${wavPath}`,
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseInt(stdout.trim(), 10));
      }
    );
  });
}

async function generateTranscript(wavPath) {
  const sampleRate = await getSampleRate(wavPath);
  const audioBytes = fs.readFileSync(wavPath).toString("base64");
  const [response] = await speechClient.recognize({
    audio: { content: audioBytes },
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: sampleRate,
      languageCode: "en-US",
    },
  });

  const transcript = response.results
    .map(r => r.alternatives[0].transcript)
    .join("\n");
  const txt = await tmpFile({ postfix: ".txt" });
  fs.writeFileSync(txt.path, transcript || "[Empty Transcript]");
  return txt;
}

app.get("/", (req, res) => res.send("Default GET"));

app.post("/", async (req, res) => {
  try {
    functions.logger.info("📩 Received POST request");

    const { userId, storageUrl } = req.body;
    if (!userId) return res.status(400).send({ error: "Missing userId" });
    if (!storageUrl) return res.status(400).send({ error: "Missing storageUrl" });

    // Parse gs:// URL
    let bucketName, filePath;
    const gsMatch = storageUrl.match(/^gs:\/\/(.+?)\/(.+)$/);
    if (gsMatch) {
      bucketName = gsMatch[1];
      filePath = gsMatch[2];
    } else {
      return res.status(400).send({ error: "Invalid storageUrl format" });
    }

    // Download .aac to tmp
    const aacTmp = await tmpFile({ postfix: ".aac" });
    await admin.storage().bucket(bucketName).file(filePath).download({ destination: aacTmp.path });
    const aacBuffer = fs.readFileSync(aacTmp.path);

    // Convert and transcribe
    const wav = await convertAacToWav(aacBuffer);
    const txt = await generateTranscript(wav.path);

    // Forward to analysis API
    const formData = new FormData();
    formData.append("audio_file", fs.createReadStream(wav.path), { filename: "audio_file.wav" });
    formData.append("text_file", fs.createReadStream(txt.path), { filename: "text_file.txt" });
    const resp = await axios.post("http://3.36.56.9:8000/analyze", formData, { headers: formData.getHeaders() });
    const dangerScore = resp.data.danger_score;

    // Actions based on score
    if (dangerScore >= 90) {
      await sendEmail(dangerScore, fs.readFileSync(wav.path), "audio.wav", fs.readFileSync(txt.path), "text.txt", "cp_zero@yonsei.ac.kr");
    }
    if (dangerScore >= 75) {
      const db = admin.database();
      const emailSnap = await db.ref(`userEmail/${userId}`).once("value");
      await sendPushNotificationToFriends(dangerScore, userId);
      await sendEmail(dangerScore, fs.readFileSync(wav.path), "audio.wav", fs.readFileSync(txt.path), "text.txt", emailSnap.val());
    }

    res.status(200).send({ dangerScore });
  } catch (err) {
    functions.logger.error("🔥 Error during processing", err);
    res.status(500).send({ error: err.message });
  }
});

async function sendEmail(score, wavBuffer, wavName, txtBuffer, txtName, recipient) {
  const wavPath = path.join("/tmp", wavName);
  const txtPath = path.join("/tmp", txtName);
  fs.writeFileSync(wavPath, wavBuffer);
  fs.writeFileSync(txtPath, txtBuffer);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });
  await transporter.sendMail({
    from: gmailUser,
    to: recipient,
    subject: "Emergency Alert",
    text: `Detected danger score: ${score}`,
    attachments: [
      { filename: wavName, path: wavPath },
      { filename: txtName, path: txtPath },
    ],
  });
}

async function sendPushNotificationToFriends(score, dangerUserId) {
  const db = admin.database();
  const userSnap = await db.ref(`username/${dangerUserId}`).once("value");
  const friendsSnap = await db.ref(`friends/${dangerUserId}`).once("value");
  const tokens = [];
  Object.values(friendsSnap.val() || {}).forEach(async id => {
    const t = (await db.ref(`fcmToken/${id}`).once("value")).val();
    if (t) tokens.push(t);
  });
  if (!tokens.length) return;
  await admin.messaging().sendMulticast({ notification: { title: "Emergency Detected", body: `${userSnap.val()} triggered ${score}` }, tokens });
}

app.use((err, req, res, next) => {
  functions.logger.error("🔥 Global error handler", err);
  res.status(500).send({ error: err.message });
});

exports.handleDangerRequest = onRequest({ region: "asia-northeast3", timeoutSeconds: 60 }, app);