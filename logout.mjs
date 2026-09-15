#!/usr/bin/env node
import { logout } from "./lib/oauth.mjs";
const st = logout();
console.log("signedIn", st.signedIn);
