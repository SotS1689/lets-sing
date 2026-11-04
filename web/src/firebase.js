// Firebase: Google sign-in and the small cloud database that keeps a signed-in
// singer's Learn scores and lesson progress (see src/sync.js). Loaded only once
// someone signs in, so the app stays as light as before for everyone else.
// This config isn't a secret: it names the project, and the database rules
// (firestore.rules) are what keep each person's data to themselves.
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from "firebase/auth";
import {
    getFirestore, doc, getDoc, setDoc, collection, query, where, orderBy, getDocs,
    writeBatch, serverTimestamp, Timestamp,
} from "firebase/firestore/lite";

const app = initializeApp({
    apiKey: "AIzaSyBTFw5ZM803fARSCCib9_SWKBNlZj8obks",
    authDomain: "lets-sing-b6277.firebaseapp.com",
    projectId: "lets-sing-b6277",
    storageBucket: "lets-sing-b6277.firebasestorage.app",
    messagingSenderId: "607939406263",
    appId: "1:607939406263:web:76bd4212aa4723cdf32032",
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export {
    GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut,
    doc, getDoc, setDoc, collection, query, where, orderBy, getDocs, writeBatch, serverTimestamp, Timestamp,
};
