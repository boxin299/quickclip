import os
import json
import logging
import pwd
import shlex
import subprocess
import tempfile

CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'folder_config.json')


def _get_real_home():
    """Get the real user home directory, unaffected by HOME env override."""
    try:
        return pwd.getpwuid(os.getuid()).pw_dir
    except Exception:
        return os.path.expanduser("~")

DEFAULT_CONFIG = {
    "local_folders": [
        "00筹备",
        "01原始素材/摄影机素材",
        "01原始素材/网络素材-原始",
        "01原始素材/其他素材",
        "02代理素材/网络素材-小样",
        "03音频/音乐",
        "03音频/音效",
        "03音频/VO",
        "04包装",
        "05特效",
        "06静帧",
        "07输出",
        "08交付",
        "09工程文件"
    ],
    "davinci_folders": [
        "原始素材/摄影机素材",
        "原始素材/网络素材-原始",
        "原始素材/其他素材",
        "代理素材/网络素材-小样",
        "音频/音乐",
        "音频/音效",
        "音频/VO",
        "包装",
        "特效",
        "静帧"
    ],
    "mapping": {
        "01原始素材/摄影机素材": "原始素材/摄影机素材",
        "01原始素材/网络素材-原始": "原始素材/网络素材-原始",
        "01原始素材/其他素材": "原始素材/其他素材",
        "02代理素材/网络素材-小样": "代理素材/网络素材-小样",
        "03音频/音乐": "音频/音乐",
        "03音频/音效": "音频/音效",
        "03音频/VO": "音频/VO",
        "04包装": "包装",
        "05特效": "特效",
        "06静帧": "静帧"
    }
}

def load_folder_config():
    if not os.path.exists(CONFIG_FILE):
        save_folder_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logging.error(f"Error loading folder config: {e}")
        return DEFAULT_CONFIG

def save_folder_config(config_data):
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config_data, f, ensure_ascii=False, indent=4)
        return True
    except Exception as e:
        logging.error(f"Error saving folder config: {e}")
        return False

def generate_automator_workflow(local_folders):
    """
    Generate an AppleScript for macOS Automator to create the specified folder
    structure. Prefer installing into ~/Library/Services; if that location is
    not writable, fall back to exporting into ~/Downloads.
    """
    try:
        workflow_name = "创建项目文件夹.workflow"
        
        # Generate the AppleScript mkdir part
        # We need to construct: quoted form of (selectedFolderPath & "/folder1") & " " & quoted form of (selectedFolderPath & "/folder2")
        mkdir_args = []
        for folder in local_folders:
            # We use POSIX path conventions for the shell script inside AppleScript
            folder_path = f"/{folder}"
            mkdir_args.append(f'quoted form of (selectedFolderPath & "{folder_path}")')
        
        mkdir_args_str = ' & " " & '.join(mkdir_args)
        if not mkdir_args_str:
             mkdir_args_str = 'quoted form of (selectedFolderPath & "/NewProject")'

        applescript_source = f'''        tell application "Finder"
            set selectedItems to selection
            if selectedItems is not {{}} then
                set selectedItem to item 1 of selectedItems
                if class of selectedItem is folder then
                    set selectedFolder to selectedItem
                else
                    set selectedFolder to container of selectedItem
                end if
            else
                try
                    set selectedFolder to target of front Finder window
                on error
                    set selectedFolder to (choose folder with prompt "选择项目根目录来创建文件夹结构：")
                end try
            end if
            set selectedFolderPath to POSIX path of (selectedFolder as text)
            do shell script "mkdir -p " & {mkdir_args_str}
        end tell'''

        # Read the template from memory/code (since we can just construct the XML)
        wflow_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
        <key>AMApplicationBuild</key>
        <string>534</string>
        <key>AMApplicationVersion</key>
        <string>2.10</string>
        <key>AMDocumentVersion</key>
        <string>2</string>
        <key>actions</key>
        <array>
                <dict>
                        <key>action</key>
                        <dict>
                                <key>AMAccepts</key>
                                <dict>
                                        <key>Container</key>
                                        <string>List</string>
                                        <key>Optional</key>
                                        <true/>
                                        <key>Types</key>
                                        <array>
                                                <string>com.apple.applescript.object</string>
                                        </array>
                                </dict>
                                <key>AMActionVersion</key>
                                <string>1.0.2</string>
                                <key>AMApplication</key>
                                <array>
                                        <string>自动操作</string>
                                </array>
                                <key>AMParameterProperties</key>
                                <dict>
                                        <key>source</key>
                                        <dict/>
                                </dict>
                                <key>AMProvides</key>
                                <dict>
                                        <key>Container</key>
                                        <string>List</string>
                                        <key>Types</key>
                                        <array>
                                                <string>com.apple.applescript.object</string>
                                        </array>
                                </dict>
                                <key>ActionBundlePath</key>
                                <string>/System/Library/Automator/Run AppleScript.action</string>
                                <key>ActionName</key>
                                <string>运行AppleScript</string>
                                <key>ActionParameters</key>
                                <dict>
                                        <key>source</key>
                                        <string>{applescript_source.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}</string>
                                </dict>
                                <key>BundleIdentifier</key>
                                <string>com.apple.Automator.RunScript</string>
                                <key>CFBundleVersion</key>
                                <string>1.0.2</string>
                                <key>CanShowSelectedItemsWhenRun</key>
                                <false/>
                                <key>CanShowWhenRun</key>
                                <true/>
                                <key>Category</key>
                                <array>
                                        <string>AMCategoryUtilities</string>
                                </array>
                                <key>Class Name</key>
                                <string>RunScriptAction</string>
                                <key>InputUUID</key>
                                <string>7B722F58-EF1F-4A06-8457-3AA66782B216</string>
                                <key>Keywords</key>
                                <array>
                                        <string>运行</string>
                                </array>
                                <key>OutputUUID</key>
                                <string>C614F7B4-B3DC-46ED-8798-6CBA5971950D</string>
                                <key>UUID</key>
                                <string>FF471EA7-9454-4695-BF8E-68A9CBDE4014</string>
                                <key>UnlocalizedApplications</key>
                                <array>
                                        <string>Automator</string>
                                </array>
                                <key>arguments</key>
                                <dict>
                                        <key>0</key>
                                        <dict>
                                                <key>default value</key>
                                                <string>on run {{input, parameters}}
        return input
end run</string>
                                                <key>name</key>
                                                <string>source</string>
                                                <key>required</key>
                                                <string>0</string>
                                                <key>type</key>
                                                <string>0</string>
                                                <key>uuid</key>
                                                <string>0</string>
                                        </dict>
                                </dict>
                                <key>isViewVisible</key>
                                <integer>1</integer>
                                <key>location</key>
                                <string>544.000000:368.000000</string>
                                <key>nibPath</key>
                                <string>/System/Library/Automator/Run AppleScript.action/Contents/Resources/Base.lproj/main.nib</string>
                        </dict>
                        <key>isViewVisible</key>
                        <integer>1</integer>
                </dict>
        </array>
        <key>connectors</key>
        <dict/>
        <key>workflowMetaData</key>
        <dict>
                <key>applicationBundleID</key>
                <string>com.apple.finder</string>
                <key>applicationBundleIDsByPath</key>
                <dict>
                        <key>/System/Library/CoreServices/Finder.app</key>
                        <string>com.apple.finder</string>
                </dict>
                <key>applicationPath</key>
                <string>/System/Library/CoreServices/Finder.app</string>
                <key>applicationPaths</key>
                <array>
                        <string>/System/Library/CoreServices/Finder.app</string>
                </array>
                <key>inputTypeIdentifier</key>
                <string>com.apple.Automator.fileSystemObject.folder</string>
                <key>outputTypeIdentifier</key>
                <string>com.apple.Automator.nothing</string>
                <key>presentationMode</key>
                <integer>15</integer>
                <key>processesInput</key>
                <false/>
                <key>serviceApplicationBundleID</key>
                <string>com.apple.finder</string>
                <key>serviceApplicationPath</key>
                <string>/System/Library/CoreServices/Finder.app</string>
                <key>serviceInputTypeIdentifier</key>
                <string>com.apple.Automator.fileSystemObject.folder</string>
                <key>serviceOutputTypeIdentifier</key>
                <string>com.apple.Automator.nothing</string>
                <key>serviceProcessesInput</key>
                <false/>
                <key>systemImageName</key>
                <string>NSTouchBarAllMyFiles</string>
                <key>useAutomaticInputType</key>
                <false/>
                <key>workflowTypeIdentifier</key>
                <string>com.apple.Automator.servicesMenu</string>
        </dict>
</dict>
</plist>"""
        
        # Also need Info.plist for it to be recognized as a valid Service
        info_plist_content = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>创建项目文件夹</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>"""

        def write_workflow_package(base_dir):
            workflow_path = os.path.join(base_dir, workflow_name)
            contents_dir = os.path.join(workflow_path, "Contents")
            os.makedirs(contents_dir, exist_ok=True)
            with open(os.path.join(contents_dir, "document.wflow"), "w", encoding="utf-8") as f:
                f.write(wflow_content)
            with open(os.path.join(contents_dir, "Info.plist"), "w", encoding="utf-8") as f:
                f.write(info_plist_content)
            return workflow_path

        # 生成到临时目录，用 open 命令执行 — Automator 会接管安装流程
        tmp_dir = os.path.join(tempfile.gettempdir(), "QuickClip")
        exported_path = write_workflow_package(tmp_dir)

        subprocess.Popen(["open", exported_path])

        return {
            "status": "success",
            "message": "快捷操作已生成，Automator 正在打开...",
            "path": exported_path,
        }
    except Exception as e:
        logging.error(f"Error generating automator workflow: {e}")
        return {"status": "error", "message": str(e)}
