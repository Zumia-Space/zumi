Zumi (Tauri build) - README for the installer kit

Repo copy of the README.txt that ships NEXT TO the installer in the owner/preview kit. It is not packaged inside the
app. <version> below is the version in the installer file name, for example 0.2.10-preview.4.

TIẾNG VIỆT
1. Chạy file "Zumi_<version>_x64-setup.exe" (bản công khai) hoặc "Zumi Preview_<version>_x64-owner-installer.exe" (bản owner).
2. Nếu Windows hiện màn hình SmartScreen màu xanh ("Windows protected your PC"): bấm "Thông tin thêm" (More info), rồi bấm "Vẫn chạy" (Run anyway). App chưa được ký số nên Windows hiện cảnh báo này. Lần mở app đầu tiên cũng có thể hiện lại cảnh báo này; làm như trên.
3. Bản công khai tự cập nhật: khi có bản mới, app tải về và hỏi bạn khởi động lại ngay hay để sau. Để kiểm tra phiên bản mới, app kết nối tới GitHub. Bản owner không tự cập nhật; mỗi bản mới là một bộ cài riêng.
   Nếu bản cập nhật bị gián đoạn (phần mềm diệt virus hoặc chương trình khác đang giữ file, đầy ổ đĩa), bản cài có thể lẫn file cũ và mới. Cách khắc phục: tải bộ cài mới nhất rồi chạy lại bộ cài bằng tay; dữ liệu của bạn vẫn còn.
4. Lần chạy đầu, nếu máy chưa có Node.js (từ bản 22 trở lên), app xin phép tải khoảng 35 MB từ nodejs.org và chỉ cài cho tài khoản Windows này. Chọn No thì không tải gì; Zumi chưa chạy được và hiện nút Thử lại.
5. Kiểm tra file: mã SHA-256 của bộ cài nằm trong SHA256SUMS.txt. Mở PowerShell trong thư mục bộ cài và chạy:
     Get-FileHash -Algorithm SHA256 ".\Zumi Preview_<version>_x64-owner-installer.exe"
   (hoặc: certutil -hashfile "Zumi Preview_<version>_x64-owner-installer.exe" SHA256)
   Mã in ra phải trùng với dòng của file đó trong SHA256SUMS.txt (không phân biệt chữ hoa/thường). Nếu khác, đừng chạy bộ cài.

ENGLISH
1. Run "Zumi_<version>_x64-setup.exe" (public build) or "Zumi Preview_<version>_x64-owner-installer.exe" (owner build).
2. If Windows shows the blue SmartScreen screen ("Windows protected your PC"), click "More info", then "Run anyway". The app is not code-signed yet, so Windows shows this warning. The first launch of the app may show it again; do the same.
3. The public build updates itself: when a new version is out, the app downloads it and asks you to restart now or later. To check for versions, the app contacts GitHub. An owner build does not update itself; each new version is a separate installer.
   If an update is interrupted (antivirus or another program holding a file, a full disk), the install can end up with a mix of old and new files. To recover, download the latest installer and run the installer by hand; your data stays.
4. On first start, if this PC has no Node.js (22 or newer), the app asks to download about 35 MB from nodejs.org and installs it for your Windows account only. Answer No and nothing is downloaded; Zumi then cannot run and shows Try again.
5. To verify the file, compare its SHA-256 with SHA256SUMS.txt. Open PowerShell in the installer folder and run:
     Get-FileHash -Algorithm SHA256 ".\Zumi Preview_<version>_x64-owner-installer.exe"
   (or: certutil -hashfile "Zumi Preview_<version>_x64-owner-installer.exe" SHA256)
   The printed hash must equal that file's line in SHA256SUMS.txt (case does not matter). If it differs, do not run the installer.
