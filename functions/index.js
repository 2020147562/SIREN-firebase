const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const multer = require("multer");
const FormData = require("form-data");
const axios = require("axios");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

admin.initializeApp();
const app = express();

// 멀터로 파일 업로드 처리
const upload = multer({ storage: multer.memoryStorage() });

const gmailUser = "siren0682@gmail.com";
const gmailPass = "solchalsiren2568";

// 이메일 전송 함수 (파일 첨부 포함)
async function sendEmailToPolice(score, wavBuffer, wavName, txtBuffer, txtName) {
  const wavPath = path.join("/tmp", wavName);
  const txtPath = path.join("/tmp", txtName);
  fs.writeFileSync(wavPath, wavBuffer);
  fs.writeFileSync(txtPath, txtBuffer);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: gmailUser,
      pass: gmailPass
    }
  });

  await transporter.sendMail({
    from: gmailUser,
    to: "cp_zero@yonsei.ac.kr",
    subject: "위험 상황 신고",
    text: `위험도 점수: ${score}`,
    attachments: [
      { filename: wavName, path: wavPath },
      { filename: txtName, path: txtPath }
    ]
  });

  console.log("이메일 전송 완료");
}

// FCM 푸쉬 전송 함수 (친구만 대상으로)
async function sendPushNotificationToFriends(score, dangerUserId) {
  const db = admin.database();

  // username 가져오기 (dangerUserId → username)
  const usernameSnap = await db.ref(`username/${dangerUserId}`).once("value");
  const username = usernameSnap.val();

  if (!username) {
    console.log("username을 찾을 수 없습니다.");
    return;
  }

  // 친구 목록 가져오기 (배열 형태)
  const friendsSnap = await db.ref(`friends/${dangerUserId}`).once("value");
  const friendsList = friendsSnap.val();

  if (!friendsList || !Array.isArray(friendsList)) {
    console.log("친구 목록이 비어있거나 올바르지 않음");
    return;
  }

  // 친구들의 fcm 토큰 가져오기
  const tokens = [];

  const tokenFetchPromises = friendsList.map(async (friendId) => {
    const tokenSnap = await db.ref(`fcm_tokens/${friendId}`).once("value");
    const token = tokenSnap.val();
    if (token) {
      tokens.push(token);
    }
  });

  await Promise.all(tokenFetchPromises);

  if (tokens.length === 0) {
    console.log("푸쉬 보낼 등록된 친구가 없거나 상응하는 토큰이 검색되지 않음.");
    return;
  }

  // 푸쉬 메시지 구성
  const payload = {
    notification: {
      title: "위험 상황 발생",
      body: `${username}님에게 위험도 ${score}인 상황이 감지되었습니다.`,
    },
    tokens: tokens,
  };

  const response = await admin.messaging().sendMulticast(payload);
  console.log("푸쉬알림 전송 완료:", response.successCount);
}

// POST 요청 핸들링
app.post("/", upload.fields([
  { name: "audio_file" }, 
  { name: "text_file" }, 
]), async (req, res) => {
  try {
    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).send({ error: "no userId sent from frontend" });
    }

    const wavFile = req.files["audio_file"]?.[0];
    const txtFile = req.files["text_file"]?.[0];
    if (!txtFile) {
      return res.status(400).send({ error: "no text file sent from frontend" });
    }

    // FastAPI로 전송
    const formData = new FormData();
    formData.append("audio_file", wavFile.buffer, wavFile.originalname);
    formData.append("text_file", txtFile.buffer, txtFile.originalname);

    const response = await axios.post("http://3.36.56.9:8000/analyze", formData, {
      headers: formData.getHeaders(),
    });

    const dangerScore = response.data.danger_score;
    console.log("dangerScore:", dangerScore);

    if (dangerScore >= 90) {
      await sendEmailToPolice(
        dangerScore,
        wavFile.buffer, wavFile.originalname,
        txtFile.buffer, txtFile.originalname
      );
    }

    if (dangerScore >= 75) {
      await sendPushNotificationToFriends(dangerScore, userId);
    }

    res.status(200).send({ "dangerScore": dangerScore });
  } catch (err) {
    console.error("error:", err.message);
    res.status(500).send({ error: "서버 오류" });
  }
});

// Firebase Function 등록
exports.handleDangerRequest = functions.https.onRequest(app);
