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
  Modal,
} from "obsidian";
import simpleGit, {
  SimpleGit,
  StatusResult,
  LogResult,
  DefaultLogFields,
} from "simple-git";

// Settings Interface
interface GitSyncSettings {
  commitInterval: number; // in minutes
  repoUrl: string;
  authMethod: "ssh" | "https";
  autoSync: boolean;
  lastSync: string;
  commitMessage: string;
  logMaxEntries: number; // New setting for max log entries
}

// Default Settings
const DEFAULT_SETTINGS: GitSyncSettings = {
  commitInterval: 15,
  repoUrl: "",
  authMethod: "ssh",
  autoSync: true,
  lastSync: "Never",
  commitMessage: "Vault auto-sync: {{date}}",
  logMaxEntries: 50, // Default to showing 50 log entries
};

// --- Git Log Modal ---
class GitLogModal extends Modal {
  logs: ReadonlyArray<DefaultLogFields> | string; // Can be structured logs or a pre-formatted string

  constructor(app: App, logs: ReadonlyArray<DefaultLogFields> | string) {
    super(app);
    this.logs = logs;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty(); // Clear previous content if any

    contentEl.createEl("h2", { text: "Git Sync Log" });

    const logContainer = contentEl.createEl("div", {
      cls: "git-sync-log-container",
    });
    logContainer.style.maxHeight = "400px";
    logContainer.style.overflowY = "auto";
    logContainer.style.fontFamily = "monospace";
    logContainer.style.whiteSpace = "pre-wrap"; // Allow wrapping long lines
    logContainer.style.padding = "10px";
    logContainer.style.border = "1px solid var(--background-modifier-border)";
    logContainer.style.borderRadius = "var(--radius-m)";
    logContainer.style.backgroundColor = "var(--background-secondary)";

    if (typeof this.logs === "string") {
      logContainer.setText(this.logs);
    } else if (Array.isArray(this.logs) && this.logs.length > 0) {
      this.logs.forEach((log) => {
        const entryEl = logContainer.createEl("div", {
          cls: "git-sync-log-entry",
        });
        entryEl.style.paddingBottom = "5px";
        entryEl.style.marginBottom = "5px";
        entryEl.style.borderBottom =
          "1px dashed var(--background-modifier-border-hover)";

        entryEl.createEl("strong", {
          text: `Commit: ${log.hash.substring(0, 7)}`,
        });
        entryEl.createEl("br");
        entryEl.createEl("span", {
          text: `Author: ${log.author_name} <${log.author_email}>`,
        });
        entryEl.createEl("br");
        entryEl.createEl("span", { text: `Date: ${log.date}` });
        entryEl.createEl("br");
        entryEl.createEl("span", { text: `Message: ${log.message}` });
      });
    } else {
      logContainer.setText("No log entries found or an error occurred.");
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Copy Logs")
          .setIcon("copy")
          .setCta()
          .onClick(async () => {
            let logText = "";
            if (typeof this.logs === "string") {
              logText = this.logs;
            } else if (Array.isArray(this.logs)) {
              logText = this.logs
                .map(
                  (log) =>
                    `Commit: ${log.hash}\nAuthor: ${log.author_name} <${log.author_email}>\nDate: ${log.date}\nMessage: ${log.message}\n---`,
                )
                .join("\n\n");
            }
            if (logText) {
              await navigator.clipboard.writeText(logText);
              new Notice("Git logs copied to clipboard!");
            } else {
              new Notice("No logs to copy.");
            }
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Close").onClick(() => {
          this.close();
        }),
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// Main Plugin Class
export default class GitSyncPlugin extends Plugin {
  settings: GitSyncSettings;
  git: SimpleGit | null = null;
  statusBarItemEl: HTMLElement;
  syncInterval: any;
  isSyncing: boolean = false;
  onExternalSettingsChange?: () => void; // Renamed from onSettingsChanged for clarity

  async onload() {
    console.log("Loading Git Sync plugin");
    await this.loadSettings();

    this.statusBarItemEl = this.addStatusBarItem();
    this.updateStatusBar("Idle");

    this.addSettingTab(new GitSyncSettingTab(this.app, this));

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

    this.addCommand({
      id: "git-sync-view-log",
      name: "View Git Sync Log",
      callback: () => this.viewGitLog(),
    });

    this.registerEvent(this.app.vault.on("modify", this.handleFileActivity));
    this.registerEvent(this.app.vault.on("delete", this.handleFileActivity));
    this.registerEvent(this.app.vault.on("rename", this.handleFileActivity));

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
        binary: "git",
        maxConcurrentProcesses: 6,
      });
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
          this.git = null;
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
    if (this.onExternalSettingsChange) {
      this.onExternalSettingsChange();
    }
  }

  async viewGitLog() {
    if (!this.git) {
      new Notice("Git Sync: Git is not initialized. Cannot view logs.");
      return;
    }
    try {
      this.updateStatusBar("Fetching log...");
      // Fetch recent logs - you can customize the format and number of entries
      const logOptions = {
        "--max-count": this.settings.logMaxEntries,
        // Example format: hash, author name, relative date, subject
        // format: {
        //   hash: '%H',
        //   date: '%ar',
        //   message: '%s',
        //   author_name: '%an',
        //   author_email: '%ae'
        // }
      };
      const logData: LogResult<DefaultLogFields> =
        await this.git.log(logOptions);
      if (logData.all && logData.all.length > 0) {
        new GitLogModal(this.app, logData.all).open();
      } else {
        new Notice("Git Sync: No log entries found.");
      }
      this.updateStatusBar("Idle");
    } catch (error: any) {
      console.error("Git Sync: Error fetching Git log", error);
      new Notice(`Git Sync: Failed to fetch Git log. ${error.message}`);
      this.updateStatusBar("Log Error");
    }
  }

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
      this.initializeGit();
      if (!this.git) return;
    }
    if (!this.settings.repoUrl) {
      this.updateStatusBar("Error: Repo URL not set");
      new Notice("Git Sync: Repository URL is not configured in settings.");
      return;
    }

    this.isSyncing = true;
    this.updateStatusBar("Syncing...");
    console.log("Git Sync: Starting vault synchronization.");
    let stashed = false;

    try {
      const initialStatus: StatusResult = await this.git.status();
      const hasLocalChanges = initialStatus.files.some(
        (file) =>
          file.working_dir !== " " ||
          (file.index !== " " && file.index !== "?"),
      );

      if (hasLocalChanges) {
        console.log("Git Sync: Local changes detected. Stashing...");
        try {
          const stashResult = await this.git.stash([
            "push",
            "-u",
            "-m",
            "GitSync_Autostash",
          ]);
          if (
            stashResult &&
            !stashResult.toLowerCase().includes("no local changes to save")
          ) {
            stashed = true;
            console.log("Git Sync: Stash successful.");
          } else {
            console.log(
              "Git Sync: No actual changes were stashed by git stash.",
            );
            stashed = false;
          }
        } catch (stashError: any) {
          console.error("Git Sync: Failed to stash changes.", stashError);
          new Notice(
            "Git Sync: Failed to stash local changes. Sync aborted to prevent data loss.",
          );
          this.updateStatusBar("Stash Error");
          this.isSyncing = false;
          return;
        }
      }

      console.log("Git Sync: Fetching from remote...");
      await this.git.fetch();
      console.log("Git Sync: Fetch successful.");

      const statusAfterFetch: StatusResult = await this.git.status();
      const currentBranch = statusAfterFetch.current;
      const trackingBranch = statusAfterFetch.tracking;

      if (!currentBranch) {
        new Notice(
          "Git Sync: Not on a branch. Please checkout a branch to sync.",
        );
        throw new Error("Git Sync: Not on a branch, cannot sync.");
      }
      if (!trackingBranch && statusAfterFetch.behind > 0) {
        new Notice(
          `Git Sync: Branch '${currentBranch}' is ${statusAfterFetch.behind} commits behind, but not tracking a remote branch. Please set upstream. Rebase skipped.`,
        );
        console.warn(
          `Git Sync: Branch '${currentBranch}' is behind but has no tracking branch. Rebase skipped.`,
        );
      }

      if (trackingBranch && statusAfterFetch.behind > 0) {
        console.log(
          `Git Sync: Local branch '${currentBranch}' is ${statusAfterFetch.behind} commits behind '${trackingBranch}'. Attempting rebase...`,
        );
        try {
          await this.git.rebase([trackingBranch]);
          console.log("Git Sync: Rebase successful.");
        } catch (rebaseError: any) {
          if (rebaseError.message && rebaseError.message.includes("CONFLICT")) {
            console.warn(
              "Git Sync: Conflict detected during rebase. Attempting to abort rebase.",
            );
            new Notice(
              "Git Sync: Merge conflict detected during rebase. Please resolve manually.",
            );
            try {
              await this.git.rebase(["--abort"]);
              new Notice(
                "Git Sync: Rebase aborted. Please resolve conflicts and sync manually.",
              );
            } catch (abortError: any) {
              console.error("Git Sync: Could not abort rebase.", abortError);
              new Notice(
                "Git Sync: Critical! Could not abort rebase. Manual Git intervention required.",
              );
            }
            throw new Error("Merge conflict during rebase, operation aborted.");
          }
          console.error("Git Sync: Rebase failed.", rebaseError);
          new Notice(
            "Git Sync: Rebase failed. Check Git status or console for details.",
          );
          throw rebaseError;
        }
      } else if (statusAfterFetch.ahead > 0 && !trackingBranch) {
        new Notice(
          `Git Sync: Branch '${currentBranch}' is ${statusAfterFetch.ahead} commits ahead, but not tracking a remote branch. Commit will be local only unless upstream is set.`,
        );
      }

      if (stashed) {
        console.log("Git Sync: Applying stashed changes...");
        try {
          await this.git.stash(["pop"]);
          console.log("Git Sync: Stash pop successful.");
        } catch (stashPopError: any) {
          if (
            stashPopError.message &&
            stashPopError.message.includes("conflict")
          ) {
            console.error(
              "Git Sync: Conflict while popping stash. Please resolve conflicts manually.",
              stashPopError,
            );
            new Notice(
              "Git Sync: Conflict after sync when applying stashed changes. Please resolve conflicts in your Git client. Your stash is likely still available.",
            );
            this.updateStatusBar("Stash Conflict!");
            throw new Error(
              "Conflict applying stashed changes. Manual resolution needed.",
            );
          }
          console.error("Git Sync: Error popping stash.", stashPopError);
          new Notice(
            "Git Sync: Error applying stashed changes. Check Git status. Your stash may still be available.",
          );
          throw stashPopError;
        }
      }

      console.log("Git Sync: Adding all files to staging area...");
      await this.git.add("./*");

      const finalStatus: StatusResult = await this.git.status();
      const filesToCommit = finalStatus.files.filter(
        (file) => file.index !== " " && file.index !== "?",
      );

      if (filesToCommit.length > 0) {
        console.log(`Git Sync: Committing ${filesToCommit.length} changes.`);
        const commitMessage = this.settings.commitMessage.replace(
          "{{date}}",
          moment().format("YYYY-MM-DD HH:mm:ss"),
        );
        await this.git.commit(commitMessage);
        console.log("Git Sync: Commit successful.");

        console.log("Git Sync: Pushing to remote...");
        if (finalStatus.tracking) {
          await this.git.push();
          console.log("Git Sync: Push successful.");
          this.settings.lastSync = moment().format("YYYY-MM-DD HH:mm:ss");
          await this.saveSettings();
          this.updateStatusBar("Synced");
          new Notice("Git Sync: Vault successfully synced with remote.");
        } else {
          console.warn(
            `Git Sync: Commit made locally, but branch '${currentBranch}' is not tracking a remote. Push skipped.`,
          );
          new Notice(
            `Git Sync: Changes committed locally. Push skipped as branch '${currentBranch}' is not tracking a remote.`,
          );
          this.settings.lastSync = moment().format("YYYY-MM-DD HH:mm:ss");
          await this.saveSettings();
          this.updateStatusBar("Committed (not pushed)");
        }
      } else {
        this.settings.lastSync = moment().format("YYYY-MM-DD HH:mm:ss");
        await this.saveSettings();
        this.updateStatusBar("Up-to-date");
        console.log(
          "Git Sync: No local changes to commit. Vault is up-to-date.",
        );
        new Notice(
          "Git Sync: Vault is up-to-date. No local changes to commit.",
        );
      }
    } catch (error: any) {
      console.error("Git Sync: Synchronization error occurred.", error);
      if (
        stashed &&
        !(
          error.message.includes("Conflict applying stashed changes") ||
          error.message.includes("Merge conflict during rebase")
        )
      ) {
        new Notice(
          "Git Sync: Sync failed. Local changes were stashed. You may need to `git stash pop` manually or check `git stash list`.",
        );
      }
      this.handleSyncError(error);
    } finally {
      this.isSyncing = false;
      console.log("Git Sync: Synchronization attempt finished.");
    }
  }

  handleFileActivity = (file: TAbstractFile) => {
    if (!this.isSyncing) {
      this.updateStatusBar("Changes detected");
    }
    console.log(
      `Git Sync: File activity detected - ${file.path} (${file instanceof TFile ? "file" : "folder"})`,
    );
  };

  handleSyncError(error: any) {
    let errorMessage = "Git Sync: An unknown error occurred.";
    const message =
      error instanceof Error && error.message ? error.message : String(error);

    if (message) {
      if (
        message.includes("CONFLICT") ||
        message.includes("conflict") ||
        (error.git &&
          error.git.failed &&
          error.git.message &&
          error.git.message.includes("conflict"))
      ) {
        errorMessage =
          "Git Sync: A conflict occurred. Please resolve it manually in your Git client.";
        this.updateStatusBar("Conflict!");
      } else if (
        message.includes("Host key verification failed") ||
        message.includes("Permission denied")
      ) {
        errorMessage =
          "Git Sync: Authentication failed. Check SSH keys or HTTPS credentials.";
        this.updateStatusBar("Auth Error");
      } else if (message.includes("not a git repository")) {
        errorMessage =
          "Git Sync: Vault is not a Git repository or .git folder is missing.";
        this.updateStatusBar("Not a repo");
      } else if (message.includes("Could not read from remote repository")) {
        errorMessage =
          "Git Sync: Cannot connect to remote. Check repository URL and network.";
        this.updateStatusBar("Remote Error");
      } else if (
        message.includes("Merge conflict during rebase, operation aborted")
      ) {
        errorMessage =
          "Git Sync: Rebase conflict. Manual resolution needed. Rebase was aborted.";
        this.updateStatusBar("Rebase Conflict!");
      } else if (message.includes("Conflict applying stashed changes")) {
        errorMessage =
          "Git Sync: Stash conflict. Manual resolution needed. Stash may still be present.";
        this.updateStatusBar("Stash Conflict!");
      } else {
        errorMessage = `Git Sync: Error - ${message.substring(0, 100)}...`;
        this.updateStatusBar("Sync Error");
      }
    }
    new Notice(errorMessage, 10000);
    console.error("Git Sync Detailed Error:", error);
  }

  startAutoSync() {
    if (this.syncInterval) return;
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
            this.display();
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
                numValue = 1;
                new Notice("Sync interval must be at least 1 minute.");
              }
              this.plugin.settings.commitInterval = numValue;
              await this.plugin.saveSettings();
              if (this.plugin.settings.autoSync) {
                this.plugin.stopAutoSync();
                this.plugin.startAutoSync();
              }
            }),
        );
    }

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

    containerEl.createEl("h3", { text: "Status & Actions" });
    const statusEl = containerEl.createEl("p", {
      text: `Last Sync: ${this.plugin.settings.lastSync}`,
    });

    // Assign the callback for updating settings display
    this.plugin.onExternalSettingsChange = () => {
      if (statusEl.isConnected) {
        // Check if element is still in DOM
        statusEl.setText(`Last Sync: ${this.plugin.settings.lastSync}`);
      }
    };

    new Setting(containerEl)
      .setName("Manual Sync")
      .setDesc("Trigger a synchronization cycle manually.")
      .addButton((button) =>
        button
          .setButtonText("Sync Now")
          .setCta()
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
            if (this.plugin.onExternalSettingsChange) {
              // Manually trigger update after sync
              this.plugin.onExternalSettingsChange();
            }
          }),
      );

    new Setting(containerEl)
      .setName("View Git Log")
      .setDesc("Display the recent Git commit log for this vault.")
      .addButton((button) =>
        button.setButtonText("View Log").onClick(() => {
          this.plugin.viewGitLog();
        }),
      );

    containerEl.createEl("h3", { text: "Advanced" });
    new Setting(containerEl)
      .setName("Max Log Entries")
      .setDesc("Maximum number of log entries to display in the Git Log view.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.logMaxEntries))
          .setValue(String(this.plugin.settings.logMaxEntries))
          .onChange(async (value) => {
            let numValue = parseInt(value);
            if (isNaN(numValue) || numValue <= 0) {
              numValue = DEFAULT_SETTINGS.logMaxEntries;
              new Notice(
                `Max log entries must be a positive number. Resetting to ${DEFAULT_SETTINGS.logMaxEntries}.`,
              );
            }
            this.plugin.settings.logMaxEntries = numValue;
            await this.plugin.saveSettings();
          }),
      );
  }
}
