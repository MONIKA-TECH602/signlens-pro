"""
server.py — SignLens PRO (Deployment Ready Version)
=====================================================
Changes made for GitHub + Render deployment:
1. Uses os.path for absolute file paths (works anywhere on server)
2. Reads PORT from environment variable (Render sets this automatically)
3. Uses opencv-python-headless (no GUI needed on server)
4. gunicorn compatible (threaded=False when using gunicorn)
"""

import os, sys, cv2, pickle, base64, sqlite3, uuid
import numpy as np
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory, g
from flask_cors import CORS
import mediapipe as mp

# ═══════════════════════════════════════════════════════
# ABSOLUTE PATHS — works on any server/computer
# os.path.abspath(__file__) = full path to this server.py file
# os.path.dirname(...)      = folder containing server.py
# ═══════════════════════════════════════════════════════
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH   = os.path.join(BASE_DIR, "model", "model.pkl")
LABELS_PATH  = os.path.join(BASE_DIR, "model", "labels.pkl")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
DB_PATH      = os.path.join(BASE_DIR, "signlens.db")

if not os.path.exists(MODEL_PATH):
    print(f"\n❌  model.pkl not found at: {MODEL_PATH}")
    print("    Run: python src/train_model.py\n")
    sys.exit(1)

# Load model
with open(MODEL_PATH,  "rb") as f: model = pickle.load(f)
with open(LABELS_PATH, "rb") as f: le    = pickle.load(f)
print(f"✓ Model loaded: {len(le.classes_)} classes")

# Database
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""CREATE TABLE IF NOT EXISTS sessions(
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
        sentence TEXT, word_count INTEGER DEFAULT 0,
        char_count INTEGER DEFAULT 0, source TEXT DEFAULT 'webcam', created_at TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS letter_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
        letter TEXT, confidence REAL, created_at TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS word_freq(
        word TEXT PRIMARY KEY, freq INTEGER DEFAULT 1, last_used TEXT)""")
    conn.commit(); conn.close()
    print("✓ Database ready")
init_db()

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db

# Word suggestions
WORDS = {
    'A':['and','are','all','also','about','any','after','again','always','already'],
    'B':['be','but','by','because','been','before','both','better','back','big','best'],
    'C':['can','could','come','came','call','change','clear','check'],
    'D':['do','did','done','does','down','day','dear','doing','different'],
    'E':['each','even','every','end','enough','early','easy','ever','everyone'],
    'F':['from','first','find','for','found','few','feel','face','finally','free'],
    'G':['get','give','good','go','got','great','going','glad','grow'],
    'H':['have','he','her','him','his','how','hello','hi','here','help','hope','happy'],
    'I':['in','it','its','into','is','if','important','inside','i'],
    'J':['just','job','join','joy'], 'K':['keep','know','kind','knew','key'],
    'L':['like','long','look','love','last','let','little','later','left','life','light'],
    'M':['me','my','more','most','many','make','may','might','much','must','meet','mind'],
    'N':['no','not','now','name','need','never','next','new','nice'],
    'O':['of','on','or','out','other','our','only','once','over','off','often','old'],
    'P':['put','place','play','people','please','part','point','possible','pretty'],
    'Q':['quite','quickly','question'],
    'R':['right','read','real','really','run','ready','remember'],
    'S':['so','some','she','say','see','should','since','something','stop','still','start','sorry'],
    'T':['the','that','this','they','there','then','them','than','take','tell','think','time','today'],
    'U':['up','use','us','under','until'], 'V':['very','view'],
    'W':['with','was','we','were','when','which','who','would','will','well','want','work','what'],
    'X':[], 'Y':['you','your','yet','yes'], 'Z':[],
}

def get_suggestions(prefix, limit=8):
    if not prefix: return []
    pl = prefix.lower(); out = []
    try:
        c = sqlite3.connect(DB_PATH)
        rows = c.execute("SELECT word FROM word_freq WHERE LOWER(word) LIKE ? ORDER BY freq DESC LIMIT ?",
            (pl+'%', limit)).fetchall(); c.close()
        out = [r[0] for r in rows]
    except: pass
    for w in WORDS.get(prefix[0].upper(), []):
        if w.lower().startswith(pl) and w not in out:
            out.append(w)
            if len(out) >= limit: break
    return out[:limit]

def save_word(word):
    if not word or len(word) < 2: return
    try:
        c = sqlite3.connect(DB_PATH)
        c.execute("INSERT INTO word_freq(word,freq,last_used) VALUES(?,1,?) ON CONFLICT(word) DO UPDATE SET freq=freq+1,last_used=?",
            (word.lower(), datetime.now().isoformat(), datetime.now().isoformat()))
        c.commit(); c.close()
    except: pass

# MediaPipe
mp_hands = mp.solutions.hands
hands_live = mp_hands.Hands(static_image_mode=False, max_num_hands=1,
    min_detection_confidence=0.35, min_tracking_confidence=0.35, model_complexity=1)
hands_static = mp_hands.Hands(static_image_mode=True, max_num_hands=1,
    min_detection_confidence=0.05, model_complexity=1)

def resize_to(img, max_dim):
    if img is None: return None
    h, w = img.shape[:2]
    if max(h,w) <= max_dim: return img
    s = max_dim / max(h,w)
    return cv2.resize(img, (int(w*s), int(h*s)), interpolation=cv2.INTER_AREA)

def enhance(img):
    if img is None: return None
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l,a,b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8,8)).apply(l)
    img = cv2.cvtColor(cv2.merge((l,a,b)), cv2.COLOR_LAB2BGR)
    return cv2.filter2D(img,-1,np.array([[0,-.5,0],[-.5,3.,-.5],[0,-.5,0]]))

def extract_features(lm):
    rx=[p.x for p in lm.landmark]; ry=[p.y for p in lm.landmark]
    mx,my=min(rx),min(ry); ext=max(max(rx)-mx,max(ry)-my)+1e-6
    nx=[(x-mx)/ext for x in rx]; ny=[(y-my)/ext for y in ry]
    return np.array([v for p in zip(nx,ny) for v in p],dtype=np.float32).reshape(1,-1)

def _predict_one(img, detector, conf_thresh):
    if img is None: return None
    h,w=img.shape[:2]
    rgb=cv2.cvtColor(img,cv2.COLOR_BGR2RGB)
    rgb.flags.writeable=False; res=detector.process(rgb); rgb.flags.writeable=True
    if not res.multi_hand_landmarks: return None
    lm=res.multi_hand_landmarks[0]
    xs=[p.x*w for p in lm.landmark]; ys=[p.y*h for p in lm.landmark]
    box={"x1":max(int(min(xs))-20,0),"y1":max(int(min(ys))-20,0),
         "x2":min(int(max(xs))+20,w),"y2":min(int(max(ys))+20,h)}
    landmarks=[[p.x,p.y] for p in lm.landmark]
    feats=extract_features(lm)
    pred_idx=model.predict(feats)[0]; proba=model.predict_proba(feats)[0]
    conf=float(proba[pred_idx]); letter=le.inverse_transform([pred_idx])[0]
    top5=[{"letter":le.inverse_transform([i])[0],"confidence":float(proba[i])} for i in np.argsort(proba)[::-1][:5]]
    if conf<conf_thresh:
        return {"detected":True,"letter":"nothing","confidence":conf,"top5":top5,"hand_box":box,"landmarks":landmarks}
    return {"detected":True,"letter":letter,"confidence":conf,"top5":top5,"hand_box":box,"landmarks":landmarks}

def _empty(): return {"detected":False,"letter":None,"confidence":0.0,"top5":[],"hand_box":None,"landmarks":[]}

def predict_upload(img_bgr):
    if img_bgr is None: return _empty()
    orig_h,orig_w=img_bgr.shape[:2]
    for target,do_enhance in [(320,True),(480,True),(320,False),(640,True),(480,False),(640,False)]:
        resized=resize_to(img_bgr,target)
        img=enhance(resized) if do_enhance else resized
        proc_h,proc_w=img.shape[:2]
        r=_predict_one(img,hands_static,0.10)
        if r and r["detected"]:
            if r.get("hand_box") and proc_w>0:
                sx=orig_w/proc_w; sy=orig_h/proc_h; b=r["hand_box"]
                r["hand_box"]={"x1":int(b["x1"]*sx),"y1":int(b["y1"]*sy),"x2":int(b["x2"]*sx),"y2":int(b["y2"]*sy)}
            return r
    return _empty()

# Flask app
app = Flask(__name__, static_folder=FRONTEND_DIR)
CORS(app)

@app.teardown_appcontext
def close_db(e=None):
    db=g.pop('db',None)
    if db: db.close()

@app.route("/")
def index(): return send_from_directory(FRONTEND_DIR,"index.html")
@app.route("/<path:path>")
def static_files(path): return send_from_directory(FRONTEND_DIR,path)

@app.route("/health")
def health(): return jsonify({"status":"ok","classes":int(len(le.classes_)),"labels":list(le.classes_)})

@app.route("/predict",methods=["POST"])
def predict():
    data=request.get_json(silent=True)
    if not data or "frame" not in data: return jsonify(_empty()),400
    try:
        b64=data["frame"]
        if "," in b64: b64=b64.split(",")[1]
        nparr=np.frombuffer(base64.b64decode(b64),np.uint8)
        img=cv2.imdecode(nparr,cv2.IMREAD_COLOR)
        if img is None: return jsonify(_empty()),400
        img=enhance(resize_to(img,640))
        result=_predict_one(img,hands_live,0.35) or _empty()
        if result["detected"] and result["letter"] not in (None,"nothing","del"):
            try:
                db=get_db()
                db.execute("INSERT INTO letter_events(session_id,letter,confidence,created_at) VALUES(?,?,?,?)",
                    (data.get("session_id","?"),result["letter"],result["confidence"],datetime.now().isoformat()))
                db.commit()
            except: pass
        return jsonify(result)
    except Exception as e:
        print(f"[predict] {e}"); return jsonify(_empty()),500

@app.route("/predict_image",methods=["POST"])
def predict_image():
    if "file" not in request.files:
        return jsonify({"detected":False,"error":"No file — do not set Content-Type header in fetch()"}),400
    f=request.files["file"]
    if not f or f.filename=='': return jsonify({"detected":False,"error":"Empty file"}),400
    try:
        raw=f.read()
        if len(raw)==0: return jsonify({"detected":False,"error":"File is empty"}),400
        nparr=np.frombuffer(raw,np.uint8)
        img=cv2.imdecode(nparr,cv2.IMREAD_COLOR)
        if img is None: return jsonify({"detected":False,"error":"Cannot decode image"}),400
        return jsonify(predict_upload(img))
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"detected":False,"error":str(e)}),500

@app.route("/predict_video",methods=["POST"])
def predict_video():
    if "file" not in request.files: return jsonify({"error":"No file"}),400
    tmp=os.path.join(BASE_DIR,f"tmp_{uuid.uuid4().hex}.mp4")
    try:
        request.files["file"].save(tmp)
        cap=cv2.VideoCapture(tmp)
        fps_src=cap.get(cv2.CAP_PROP_FPS) or 30
        interval=max(1,int(fps_src))
        results,idx=[],0
        while cap.isOpened():
            ret,frame=cap.read()
            if not ret: break
            if idx%interval==0:
                r=predict_upload(frame)
                if r["detected"] and r["letter"] not in (None,"nothing","del"):
                    results.append({"frame_index":idx,"time_sec":round(idx/fps_src,1),
                        "letter":r["letter"],"confidence":r["confidence"],"top5":r["top5"]})
            idx+=1
        cap.release()
        sentence,prev="",None
        for r in results:
            if r["letter"]!=prev: sentence+=r["letter"]; prev=r["letter"]
        return jsonify({"frames":results,"sentence":sentence,"total":len(results)})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error":str(e)}),500
    finally:
        if os.path.exists(tmp): os.remove(tmp)

@app.route("/suggest")
def suggest(): return jsonify({"suggestions":get_suggestions(request.args.get("prefix","").strip(),8)})

@app.route("/save_session",methods=["POST"])
def save_session():
    data=request.get_json(silent=True) or {}
    sentence=data.get("sentence","").strip()
    if not sentence: return jsonify({"error":"No sentence"}),400
    try:
        words=sentence.split(); sid=data.get("session_id",str(uuid.uuid4()))
        db=get_db()
        db.execute("INSERT INTO sessions(session_id,sentence,word_count,char_count,source,created_at) VALUES(?,?,?,?,?,?)",
            (sid,sentence,len(words),len(sentence),data.get("source","webcam"),datetime.now().isoformat()))
        db.commit()
        for w in words: save_word(w)
        return jsonify({"saved":True,"session_id":sid})
    except Exception as e: return jsonify({"error":str(e)}),500

@app.route("/history")
def history():
    try:
        rows=get_db().execute("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 20").fetchall()
        return jsonify({"history":[dict(r) for r in rows]})
    except Exception as e: return jsonify({"error":str(e),"history":[]}),500

@app.route("/history/<int:sid>",methods=["DELETE"])
def delete_session(sid):
    try:
        db=get_db(); db.execute("DELETE FROM sessions WHERE id=?",(sid,)); db.commit()
        return jsonify({"deleted":True})
    except Exception as e: return jsonify({"error":str(e)}),500

@app.route("/stats")
def stats():
    try:
        db=get_db()
        ts=db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        tl=db.execute("SELECT COUNT(*) FROM letter_events").fetchone()[0]
        tw=db.execute("SELECT SUM(word_count) FROM sessions").fetchone()[0] or 0
        tlt=db.execute("SELECT letter,COUNT(*) c FROM letter_events GROUP BY letter ORDER BY c DESC LIMIT 5").fetchall()
        tww=db.execute("SELECT word,freq FROM word_freq ORDER BY freq DESC LIMIT 8").fetchall()
        return jsonify({"total_sessions":ts,"total_letters":tl,"total_words":int(tw),
            "top_letters":[{"letter":r[0],"count":r[1]} for r in tlt],
            "top_words":[{"word":r[0],"freq":r[1]} for r in tww]})
    except Exception as e: return jsonify({"error":str(e)}),500

# ═══════════════════════════════════════════════════════
# START SERVER
# PORT comes from environment variable on Render
# Falls back to 5000 for local development
# ═══════════════════════════════════════════════════════
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n{'='*45}")
    print(f"  SignLens PRO  →  http://localhost:{port}")
    print(f"{'='*45}\n")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
