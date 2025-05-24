import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  moment,
  FileSystemAdapter,
  TAbstractFile,
  Notice,
} from "obsidian";
import simpleGit, { SimpleGit, StatusResult } from "simple-git";

// Settings Interface
interface GitSyncSettings {
  commitInterval: number; // in minutes
  repoUrl: string;
  authMethod: "ssh" | "https"; // Assuming these are the primary methods you'll support initially
  autoSync: boolean;
  lastSync: string;
  commitMessage: string;
}

// Default Settings
const DEFAULT_SETTINGS: GitSyncSettings = {
  commitInterval: 15, // Default to 15 minutes
  repoUrl: "",
  authMethod: "ssh",
  autoSync: true,
  lastSync: "Never",
  commitMessage: "Vault auto-sync: {{date}}", // Customizable commit message with placeholder
};

// Main Plugin Class
export default class GitSyncPlugin extends Plugin {
  settings: GitSyncSettings;
  git: SimpleGit | null = null; // Initialize as null, set up when path is confirmed
  statusBarItemEl: HTMLElement;
  syncInterval: any; // For window.setInterval
  isSyncing: boolean = false; // To prevent concurrent sync operations

  async onload() {
    console.log("Loading Git Sync plugin");
    await this.loadSettings();

    this.statusBarItemEl = this.addStatusBarItem();
    this.updateStatusBar("Idle");

    this.addSettingTab(new GitSyncSettingTab(this.app, this));

    // Initialize Git instance
    this.initializeGit();

    if (this.settings.autoSync && this.git) {
      this.startAutoSync();
    }

    this.addCommand({
      id: "git-sync-now",
      name: "Sync with Remote",
      callback: () => {
        if (this.git) {
          this.syncVault();
        } else {
          new Notice(
            "Git Sync: Repository not initialized or path not found. Check settings.",
          );
          this.updateStatusBar("Error: Git not init");
        }
      },
    });

    // Listen for vault modifications
    this.registerEvent(this.app.vault.on("modify", this.handleFileActivity));
    this.registerEvent(this.app.vault.on("delete", this.handleFileActivity));
    this.registerEvent(this.app.vault.on("rename", this.handleFileActivity));

    // Attempt to sync on startup if autoSync is enabled
    if (this.settings.autoSync && this.settings.repoUrl) {
      console.log("Git Sync: Attempting initial sync on load.");
      this.syncVault().catch((error) => {
        console.error("Git Sync: Initial sync failed", error);
        new Notice("Git Sync: Initial sync failed. Check console for details.");
        this.updateStatusBar("Initial Sync Failed");
      });
    }
  }

  onunload() {
    console.log("Unloading Git Sync plugin");
    this.stopAutoSync();
  }

  initializeGit() {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      const basePath = adapter.getBasePath();
      console.log(`Git Sync: Initializing Git in ${basePath}`);
      this.git = simpleGit({
        baseDir: basePath,
        binary: "git", // Ensure this points to user's git executable if not in PATH
        maxConcurrentProcesses: 6,
      });
      // Verify git is working
      this.git
        .version()
        .then((v) =>
          console.log(
            `Git Sync: Git version ${v.major}.${v.minor}.${v.patch} initialized.`,
          ),
        )
        .catch((err) => {
          console.error(
            "Git Sync: Failed to initialize Git. Is Git installed and in PATH?",
            err,
          );
          new Notice(
            "Git Sync: Failed to initialize Git. Ensure Git is installed and in your system's PATH.",
          );
          this.git = null; // Nullify git if initialization fails
          this.updateStatusBar("Error: Git init failed");
        });
    } else {
      console.error(
        "Git Sync: Vault is not on a local filesystem. Git Sync disabled.",
      );
      new Notice(
        "Git Sync: Vault must be on a local filesystem for Git Sync to work.",
      );
      this.updateStatusBar("Error: Not local vault");
      this.git = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // --- Sync Logic ---
  async syncVault() {
    if (this.isSyncing) {
      new Notice("Git Sync: Sync already in progress.");
      console.log("Git Sync: Sync already in progress, skipping.");
      return;
    }
    if (!this.git) {
      new Notice(
        "Git Sync: Git is not initialized. Check plugin settings and console.",
      );
      this.updateStatusBar("Error: Git not ready");
      this.initializeGit(); // Attempt to re-initialize
      if (!this.git) return; // If still not initialized, exit
    }
    if (!this.settings.repoUrl) {
      this.updateStatusBar("Error: Repo URL not set");
      new Notice("Git Sync: Repository URL is not configured in settings.");
      return;
    }

    this.isSyncing = true;
    this.updateStatusBar("Syncing...");
    console.log("Git Sync: Starting vault synchronization.");

    try {
      // 1. Fetch changes from remote to check for remote updates
      // This helps in understanding if a pull is needed before committing.
      // For simplicity in this example, we'll pull directly.
      // More advanced: `git fetch` then `git status` to see if remote is ahead.
      console.log("Git Sync: Pulling from remote...");
      await this.git
        .pull({ "--rebase": "true", "--autostash": "true" })
        .catch(async (pullError) => {
          // Handle common pull errors, e.g., conflicts after rebase
          if (pullError.message.includes("CONFLICT")) {
            console.warn(
              "Git Sync: Merge conflict after pull. Attempting to abort rebase.",
            );
            new Notice(
              "Git Sync: Merge conflict detected during pull. Please resolve manually.",
            );
            // Attempt to abort the rebase to leave the working directory clean for manual resolution
            try {
              await this.git?.rebase({ "--abort": null });
              new Notice(
                "Git Sync: Rebase aborted. Please resolve conflicts and sync manually.",
              );
            } catch (abortError) {
              console.error("Git Sync: Could not abort rebase.", abortError);
              new Notice(
                "Git Sync: Critical! Could not abort rebase. Manual Git intervention required.",
              );
            }
            throw new Error("Merge conflict during pull, rebase aborted."); // Propagate error
          }
          // If not a conflict, or if abort failed, re-throw
          throw pullError;
        });
      console.log("Git Sync: Pull successful.");

      // 2. Add all changes (new, modified, deleted files)
      console.log("Git Sync: Adding files to staging...");
      await this.git.add("./*"); // Stages all changes in the vault directory

      // 3. Check status to see if there's anything to commit
      const status: StatusResult = await this.git.status();
      const filesToCommit = status.files.filter(
        (file) => file.working_dir !== " " && file.working_dir !== "?",
      ); // Exclude untracked unless explicitly handled

      if (filesToCommit.length > 0) {
        console.log(`Git Sync: Committing ${filesToCommit.length} changes.`);
        const commitMessage = this.settings.commitMessage.replace(
          "{{date}}",
          moment().format("YYYY-MM-DD HH:mm:ss"),
        );
        await this.git.commit(commitMessage);
        console.log("Git Sync: Commit successful.");

        // 4. Push changes
        console.log("Git Sync: Pushing to remote...");
        await this.git.push();
        console.log("Git Sync: Push successful.");

        this.settings.lastSync = moment().format("YYYY-MM-DD HH:mm:ss");
        await this.saveSettings(); // Save last sync time
        this.updateStatusBar("Synced");
        new Notice("Git Sync: Vault successfully synced with remote.");
      } else {
        this.settings.lastSync = moment().format("YYYY-MM-DD HH:mm:ss"); // Update last sync even if no local changes, as pull might have occurred
        await this.saveSettings();
        this.updateStatusBar("No local changes");
        console.log("Git Sync: No local changes to commit.");
        new Notice(
          "Git Sync: No local changes to commit. Vault is up-to-date with remote.",
        );
      }
    } catch (error: any) {
      console.error("Git Sync: Synchronization error", error);
      this.handleSyncError(error); // Centralized error handling
    } finally {
      this.isSyncing = false;
      console.log("Git Sync: Synchronization attempt finished.");
    }
  }

  // Updated to handle TAbstractFile
  handleFileActivity = (file: TAbstractFile) => {
    // This function is called on file modify, delete, or rename.
    // It can be used to trigger a sync or update UI.
    // For now, just indicates activity.
    if (!this.isSyncing) {
      // Avoid changing status if a sync is already in progress
      this.updateStatusBar("Changes detected");
    }
    console.log(
      `Git Sync: File activity detected - ${file.path} (${file instanceof TFile ? "file" : "folder"})`,
    );
    // Debouncing or delaying sync after activity can be added here
    // For example, trigger a sync after a short period of inactivity.
  };

  handleSyncError(error: any) {
    let errorMessage = "Git Sync: An unknown error occurred.";
    if (error.message) {
      if (
        error.message.includes("CONFLICT") ||
        (error.git &&
          error.git.failed &&
          error.git.message.includes("conflict"))
      ) {
        errorMessage =
          "Git Sync: Merge conflict detected. Please resolve it manually in your Git client.";
        this.updateStatusBar("Conflict!");
      } else if (
        error.message.includes("Host key verification failed") ||
        error.message.includes("Permission denied")
      ) {
        errorMessage =
          "Git Sync: Authentication failed. Check SSH keys or HTTPS credentials.";
        this.updateStatusBar("Auth Error");
      } else if (error.message.includes("not a git repository")) {
        errorMessage =
          "Git Sync: Vault is not a Git repository or .git folder is missing.";
        this.updateStatusBar("Not a repo");
      } else if (
        error.message.includes("Could not read from remote repository")
      ) {
        errorMessage =
          "Git Sync: Cannot connect to remote. Check repository URL and network.";
        this.updateStatusBar("Remote Error");
      } else {
        errorMessage = `Git Sync: Error - ${error.message.substring(0, 100)}...`; // Keep it concise for Notice
        this.updateStatusBar("Sync Error");
      }
    }
    new Notice(errorMessage, 10000); // Show notice for 10 seconds
    console.error("Git Sync Detailed Error:", error); // Log the full error
  }

  // --- Automation ---
  startAutoSync() {
    if (this.syncInterval) return; // Already running
    if (!this.git) {
      console.log("Git Sync: Auto Sync cannot start, Git not initialized.");
      return;
    }
    const intervalMillis = this.settings.commitInterval * 60 * 1000;
    if (intervalMillis <= 0) {
      console.log(
        "Git Sync: Auto Sync interval is zero or negative, not starting.",
      );
      return;
    }

    console.log(
      `Git Sync: Starting auto-sync every ${this.settings.commitInterval} minutes.`,
    );
    this.syncInterval = window.setInterval(() => {
      console.log("Git Sync: Auto-sync triggered by interval.");
      this.syncVault();
    }, intervalMillis);
  }

  stopAutoSync() {
    if (this.syncInterval) {
      window.clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log("Git Sync: Auto-sync stopped.");
    }
  }

  // --- UI ---
  updateStatusBar(text: string) {
    if (this.statusBarItemEl) {
      this.statusBarItemEl.setText(`Git Sync: ${text}`);
    }
  }
}

// --- Settings Tab ---
class GitSyncSettingTab extends PluginSettingTab {
  plugin: GitSyncPlugin;

  constructor(app: App, plugin: GitSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Git Sync Settings" });

    // --- General Settings ---
    containerEl.createEl("h3", { text: "General" });
    new Setting(containerEl)
      .setName("Enable Auto Sync")
      .setDesc("Automatically sync your vault at the defined interval.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
            if (value && this.plugin.git) {
              this.plugin.startAutoSync();
            } else {
              this.plugin.stopAutoSync();
            }
            this.display(); // Refresh settings tab to show/hide interval
          }),
      );

    if (this.plugin.settings.autoSync) {
      new Setting(containerEl)
        .setName("Sync Interval (minutes)")
        .setDesc(
          "How often to automatically commit and push changes. Minimum 1 minute.",
        )
        .addText((text) =>
          text
            .setPlaceholder("15")
            .setValue(String(this.plugin.settings.commitInterval))
            .onChange(async (value) => {
              let numValue = Number(value);
              if (isNaN(numValue) || numValue < 1) {
                numValue = 1; // Enforce minimum
                new Notice("Sync interval must be at least 1 minute.");
              }
              this.plugin.settings.commitInterval = numValue;
              await this.plugin.saveSettings();
              // Restart auto-sync with new interval if it's enabled
              if (this.plugin.settings.autoSync) {
                this.plugin.stopAutoSync();
                this.plugin.startAutoSync();
              }
            }),
        );
    }

    // --- Repository Settings ---
    containerEl.createEl("h3", { text: "Repository" });
    new Setting(containerEl)
      .setName("Repository URL")
      .setDesc(
        "The HTTPS or SSH URL of your remote Git repository (e.g., https://github.com/user/repo.git or git@github.com:user/repo.git).",
      )
      .addText((text) =>
        text
          .setPlaceholder("https://github.com/user/repo.git")
          .setValue(this.plugin.settings.repoUrl)
          .onChange(async (value) => {
            this.plugin.settings.repoUrl = value.trim();
            await this.plugin.saveSettings();
            // Re-initialize git or update remote if needed
            this.plugin.initializeGit();
          }),
      );

    new Setting(containerEl)
      .setName("Commit Message")
      .setDesc(
        "Customize the commit message. Use {{date}} for the current timestamp.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.commitMessage)
          .setValue(this.plugin.settings.commitMessage)
          .onChange(async (value) => {
            this.plugin.settings.commitMessage = value;
            await this.plugin.saveSettings();
          }),
      );

    // Authentication method is often inferred by Git from the URL (HTTPS vs SSH)
    // Or handled by credential managers / SSH agent. Explicitly setting it might be complex
    // and less user-friendly than letting Git handle it.
    // For now, removing explicit authMethod setting to rely on Git's built-in handling.
    // If specific auth flow is needed, it can be added back with more robust logic.
    new Setting(containerEl)
      .setName("Authentication Method")
      .setDesc(
        "Git will typically use SSH for git@ URLs and HTTPS for https:// URLs. Ensure your Git client is configured.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ssh", "SSH (git@example.com:...)")
          .addOption("https", "HTTPS (https://example.com/...)")
          .setValue(this.plugin.settings.authMethod)
          .onChange(async (value: "ssh" | "https") => {
            this.plugin.settings.authMethod = value;
            await this.plugin.saveSettings();
          }),
      );

    // --- Status & Actions ---
    containerEl.createEl("h3", { text: "Status & Actions" });
    const statusEl = containerEl.createEl("p", {
      text: `Last Sync: ${this.plugin.settings.lastSync}`,
    });
    // Update last sync time dynamically if settings are re-rendered
    this.plugin.onExternalSettingsChange = () => {
      statusEl.setText(`Last Sync: ${this.plugin.settings.lastSync}`);
    };

    new Setting(containerEl)
      .setName("Manual Sync")
      .setDesc("Trigger a synchronization cycle manually.")
      .addButton((button) =>
        button
          .setButtonText("Sync Now")
          .setCta() // Makes the button more prominent
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Syncing...");
            if (this.plugin.git) {
              await this.plugin.syncVault();
            } else {
              new Notice(
                "Git Sync: Repository not initialized. Check settings.",
              );
              this.plugin.updateStatusBar("Error: Git not init");
            }
            button.setDisabled(false);
            button.setButtonText("Sync Now");
            // Refresh last sync time on settings page
            statusEl.setText(`Last Sync: ${this.plugin.settings.lastSync}`);
          }),
      );

    // --- Troubleshooting & Advanced ---
    // Potentially add:
    // - Button to open Git log
    // - Option to re-initialize .git (with caution)
    // - Link to Git/SSH setup guides
  }

  // Helper to allow plugin to notify settings tab of changes
  onSettingsChanged?: () => void;
}
