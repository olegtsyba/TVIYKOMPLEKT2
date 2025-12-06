import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// Configuration from admin.html
const firebaseConfig = {
  apiKey: "AIzaSyBcnbheQccvMjAX_xCFGaPy1RlOTE_UPm8",
  authDomain: "tviykomplekt-88100.firebaseapp.com",
  projectId: "tviykomplekt-88100",
  storageBucket: "tviykomplekt-88100.firebasestorage.app",
  messagingSenderId: "171289333626",
  appId: "1:171289333626:web:fbf1dd2f2746984d9ad0c3",
  measurementId: "G-C862G7Z28Y"
};

// Initialize Firebase (check if already initialized for hot-reload safety)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const db = getFirestore(app);
export const storage = getStorage(app);