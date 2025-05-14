const functions = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
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
const { getMessaging } = require("firebase-admin/messaging");

admin.initializeApp();
const app = express();
const speechClient = new SpeechClient();

// JSON body parsing
app.use(express.json());

// Gmail credentials from env
const gmailUser = defineSecret("GMAIL_USER");
const gmailPass = defineSecret("GMAIL_PASS");

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

    const { userId, storageUrl, latitude, longitude } = req.body;
    if (!userId) return res.status(400).send({ error: "Missing userId" });
    if (!storageUrl) return res.status(400).send({ error: "Missing storageUrl" });
    if (!latitude) return res.status(400).send({ error: "Missing latitude" });
    if (!longitude) return res.status(400).send({ error: "Missing longitude" });

    const db = admin.database();
    const userSnap   = await db.ref(`username/${dangerUserId}`).once("value");
    const username   = userSnap.val();

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
      await sendEmail(dangerScore, fs.readFileSync(wav.path), "audio.wav", fs.readFileSync(txt.path), "text.txt", "cp_zero@yonsei.ac.kr", latitude, longitude, username);
    }
    if (dangerScore >= 75) {
        // 1) 친구 목록 가져오기
        const friendsSnap = await db.ref(`friends/${userId}`).once("value");
        const friendsObj  = friendsSnap.val() || {};
        const friendIds   = Object.values(friendsObj); // 친구들의 userId 리스트

        // 2) 친구들한테 푸시 알림
        await sendPushNotificationToFriends(dangerScore, userId, username);

        // 3) 친구들 모두에게 이메일 전송
        for (const friendId of friendIds) {
            const emailSnap = await db.ref(`userEmail/${friendId}`).once("value");
            const friendEmail = emailSnap.val();

            if (friendEmail) {
            await sendEmail(
                dangerScore,
                fs.readFileSync(wav.path),
                "audio.wav",
                fs.readFileSync(txt.path),
                "text.txt",
                friendEmail,
                latitude,
                longitude,
                username
            );
            functions.logger.info("📧 Email sent to friend", { friendId, friendEmail });
            } else {
            functions.logger.warn("⚠️ Friend email not found, skipping", { friendId });
            }
        }
    }

    res.status(200).send({ dangerScore });
  } catch (err) {
    functions.logger.error("🔥 Error during processing", err);
    res.status(500).send({ error: err.message });
  }
});

async function sendEmail(score, wavBuffer, wavName, txtBuffer, txtName, recipient, latitude, longitude, username) {
    // SecretParam에서 실제 문자열을 가져옵니다.
    const user = await gmailUser.value();
    const pass = await gmailPass.value();
  
    const wavPath = path.join("/tmp", wavName);
    const txtPath = path.join("/tmp", txtName);
    fs.writeFileSync(wavPath, wavBuffer);
    fs.writeFileSync(txtPath, txtBuffer);
  
    functions.logger.info("📧 Preparing to send email", { to: recipient, wavPath, txtPath, score });
  
    // user, pass에 실제 문자열을 전달해야 합니다.
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  
    try {
      const info = await transporter.sendMail({
        from: user,
        to: recipient,
        subject: "SIREN: Emergency Alert",
        text: `Dear trusted contact, a user of SIREN,

        An emergency situation has been detected based on the analysis of recent voice and speech input.

        Danger Score: ${score}
        Location of ${username}: https://www.google.com/maps?q=${latitude},${longitude}

        This score indicates a potentially critical or harmful interaction. For your review and further action, we have attached:
        - The original audio recording (.wav)
        - The transcribed speech content (.txt)

        Please assess the situation and take appropriate measures if necessary.

        Sincerely,
        SIREN Automated Alert System`,
        attachments: [
          { filename: wavName, path: wavPath },
          { filename: txtName, path: txtPath },
        ],
      });
      functions.logger.info("✅ Email sent successfully", { messageId: info.messageId, to: recipient });
    } catch (err) {
      functions.logger.error("❌ Failed to send email", { to: recipient, error: err.message });
      throw err;
    }
}
  
async function sendPushNotificationToFriends(score, dangerUserId, username) {
    const db = admin.database();
    functions.logger.info("🔔 Preparing push notifications", { userId: dangerUserId, username, score });

    const friendsSnap = await db.ref(`friends/${dangerUserId}`).once("value");
    const friends     = friendsSnap.val() || {};
    const tokens      = [];

    // 친구별로 FCM 토큰 수집
    for (const friendId of Object.values(friends)) {
        const tSnap = await db.ref(`fcmToken/${friendId}`).once("value");
        const token = tSnap.val();
        if (token) tokens.push(token);
    }

    if (tokens.length === 0) {
        functions.logger.warn("⚠️ No FCM tokens found, skipping push", { userId: dangerUserId });
        return;
    }

    // 메시지 페이로드 배열 생성
    const messages = tokens.map(token => ({
        token,
        notification: {
        title: "Emergency Detected",
        body: `${username} has triggered a danger score of ${score}.`,
        },
    }));

    const response = await getMessaging().sendEach(messages);
    functions.logger.info("✅ Push notifications sent", {
        successCount: response.successCount,
        failureCount: response.failureCount,
    });
}

app.use((err, req, res, next) => {
  functions.logger.error("🔥 Global error handler", err);
  res.status(500).send({ error: err.message });
});

exports.handleDangerRequest = onRequest({ region: "asia-northeast3", timeoutSeconds: 60, secrets: ["GMAIL_USER", "GMAIL_PASS"] }, app);