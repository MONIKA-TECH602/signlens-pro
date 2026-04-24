"""
train_model.py  —  Train Random Forest on landmark CSV, save model.pkl

Usage: python src/train_model.py
Output: model/model.pkl, model/labels.pkl, model/confusion_matrix.png
"""
import os, pickle
import numpy as np, pandas as pd, matplotlib.pyplot as plt
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.metrics import accuracy_score, classification_report, ConfusionMatrixDisplay, confusion_matrix

DATA_PATH  = "dataset/data.csv"
MODEL_PATH = "model/model.pkl"
LABELS_PATH= "model/labels.pkl"

print(f"Loading {DATA_PATH}...")
df = pd.read_csv(DATA_PATH)
print(f"  Samples: {len(df)} | Classes: {sorted(df['label'].unique())}\n")

X = df.drop(columns=["label"]).values.astype(np.float32)
le = LabelEncoder()
y  = le.fit_transform(df["label"].values)

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.15, random_state=42, stratify=y)

pipeline = Pipeline([
    ("scaler", StandardScaler()),
    ("clf", RandomForestClassifier(n_estimators=100, random_state=42, n_jobs=-1, class_weight="balanced"))
])

print("Training Random Forest...")
pipeline.fit(X_train, y_train)

y_pred = pipeline.predict(X_test)
acc    = accuracy_score(y_test, y_pred)
print(f"\nTest Accuracy: {acc*100:.2f}%\n")
print(classification_report(y_test, y_pred, target_names=le.classes_))

fig, ax = plt.subplots(figsize=(14,12))
ConfusionMatrixDisplay(confusion_matrix(y_test,y_pred), display_labels=le.classes_).plot(ax=ax, colorbar=True, xticks_rotation=45)
ax.set_title(f"Confusion Matrix — {acc*100:.1f}%", fontsize=13)
plt.tight_layout()
os.makedirs("model", exist_ok=True)
plt.savefig("model/confusion_matrix.png", dpi=150)
print("Saved model/confusion_matrix.png")

with open(MODEL_PATH,"wb") as f: pickle.dump(pipeline, f)
with open(LABELS_PATH,"wb") as f: pickle.dump(le, f)
print(f"\n✓ Model → {MODEL_PATH}")
print(f"✓ Labels → {LABELS_PATH}")
print("\nNext: python server.py")
