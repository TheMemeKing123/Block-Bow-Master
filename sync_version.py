import shutil, os
os.makedirs(os.path.join("public","v5"), exist_ok=True)
shutil.copy(os.path.join("public","index.html"), os.path.join("public","v5","index.html"))
print("v5/index.html synced")
