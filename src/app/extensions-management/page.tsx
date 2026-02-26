"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/app-config";
import {
    dbCreateDatabaseRole,
    dbCreateDatabaseUser,
    dbDeleteDatabaseUser,
    dbDeletePasswordReminder,
    dbGetAccessProfile,
    dbGetDatabaseRoleDetail,
    dbGetExtensionDetail,
    dbGrantDatabaseRoleMembership,
    dbInstallExtension,
    dbListDatabaseRoles,
    dbListDatabaseUsers,
    dbListExtensions,
    dbListPasswordReminders,
    dbRevokeDatabaseRoleMembership,
    dbSetDatabaseUserLogin,
    dbSetDatabaseUserPassword,
    dbUninstallExtension,
    dbUpdateExtension,
} from "@/lib/tauri";
import type {
    CreateDatabaseRoleRequest,
    CreateDatabaseUserRequest,
    DatabaseAccessProfile,
    DatabaseExtensionDetail,
    DatabaseExtensionInfo,
    DatabaseRoleDetail,
    DatabaseRoleInfo,
    DatabaseUserInfo,
    PasswordReminder,
} from "@/lib/types";
import { useConnectionStore } from "@/stores/connection-store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/ui/tabs";
import {
    ArrowLeft,
    BookOpenCheck,
    CheckCircle2,
    CircleSlash,
    Cog,
    KeyRound,
    Loader2,
    PanelRightOpen,
    RefreshCw,
    Search,
    ShieldCheck,
    Trash2,
    UserCheck,
    UserCog,
    UserPlus,
    UserRound,
    UserRoundX,
    UsersRound,
    Wrench,
} from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

type TabKey = "extensions" | "users";
type ExtensionFilter = "all" | "installed" | "available";

type CreateUserFormState = {
    username: string;
    password: string;
    validUntil: string;
    passwordReminder: string;
    canCreateDb: boolean;
    canCreateRole: boolean;
    isSuperuser: boolean;
    inherit: boolean;
    replication: boolean;
    bypassRls: boolean;
    roleMemberships: string[];
};

type CreateRoleFormState = {
    roleName: string;
    inherit: boolean;
    memberships: string[];
};

const DEFAULT_CREATE_USER_FORM: CreateUserFormState = {
    username: "",
    password: "",
    validUntil: "",
    passwordReminder: "",
    canCreateDb: false,
    canCreateRole: false,
    isSuperuser: false,
    inherit: true,
    replication: false,
    bypassRls: false,
    roleMemberships: [],
};

const DEFAULT_CREATE_ROLE_FORM: CreateRoleFormState = {
    roleName: "",
    inherit: true,
    memberships: [],
};

export default function ExtensionsManagementPage() {
    const {
        connectionId,
        isConnected,
        databaseName,
        serverVersion,
        disconnect,
        markPostConnectRedirectConsumed,
    } = useConnectionStore();

    const [accessProfile, setAccessProfile] = useState<DatabaseAccessProfile | null>(null);
    const [extensions, setExtensions] = useState<DatabaseExtensionInfo[]>([]);
    const [extensionDetailsByName, setExtensionDetailsByName] = useState<Record<string, DatabaseExtensionDetail>>({});
    const [roles, setRoles] = useState<DatabaseRoleInfo[]>([]);
    const [users, setUsers] = useState<DatabaseUserInfo[]>([]);
    const [reminders, setReminders] = useState<PasswordReminder[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [activeTab, setActiveTab] = useState<TabKey>("extensions");

    const [extensionSearch, setExtensionSearch] = useState("");
    const [extensionFilter, setExtensionFilter] = useState<ExtensionFilter>("all");
    const [selectedExtensionName, setSelectedExtensionName] = useState<string | null>(null);
    const [isLoadingExtensionDetail, setIsLoadingExtensionDetail] = useState(false);
    const [extensionActionBusy, setExtensionActionBusy] = useState<"install" | "uninstall" | "update" | null>(null);
    const [extensionUpdateVersion, setExtensionUpdateVersion] = useState<string>("__latest");
    const [isExtensionDetailDialogOpen, setIsExtensionDetailDialogOpen] = useState(false);

    const [userSearch, setUserSearch] = useState("");
    const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
    const [userActionBusy, setUserActionBusy] = useState<"toggle" | "delete" | "password" | "create" | null>(null);
    const [newPassword, setNewPassword] = useState("");
    const [deleteReassignTo, setDeleteReassignTo] = useState<string>("__none");
    const [isUserDetailDialogOpen, setIsUserDetailDialogOpen] = useState(false);
    const [isManageMembershipDialogOpen, setIsManageMembershipDialogOpen] = useState(false);
    const [membershipDraft, setMembershipDraft] = useState<string[]>([]);
    const [membershipWithAdminOption, setMembershipWithAdminOption] = useState(false);

    const [createUserForm, setCreateUserForm] = useState<CreateUserFormState>(DEFAULT_CREATE_USER_FORM);
    const [createRoleForm, setCreateRoleForm] = useState<CreateRoleFormState>(DEFAULT_CREATE_ROLE_FORM);
    const [isCreateRoleDialogOpen, setIsCreateRoleDialogOpen] = useState(false);
    const [roleActionBusy, setRoleActionBusy] = useState<"create" | "membership" | null>(null);

    const [roleSearch, setRoleSearch] = useState("");
    const [selectedRoleName, setSelectedRoleName] = useState<string | null>(null);
    const [roleDetailsByName, setRoleDetailsByName] = useState<Record<string, DatabaseRoleDetail>>({});
    const [isLoadingRoleDetail, setIsLoadingRoleDetail] = useState(false);
    const [isRoleDetailDialogOpen, setIsRoleDetailDialogOpen] = useState(false);

    const pgVersion = serverVersion
        ? serverVersion.match(/PostgreSQL\s+([\d.]+)/i)?.[1] ?? ""
        : "";

    const loadManagementData = useCallback(
        async (showRefreshingState = false) => {
            if (!connectionId) return;

            if (showRefreshingState) setIsRefreshing(true);
            else setIsLoading(true);

            setError(null);
            try {
                const [profile, extensionList, roleList, userList, reminderList] =
                    await Promise.all([
                        dbGetAccessProfile(connectionId),
                        dbListExtensions(connectionId),
                        dbListDatabaseRoles(connectionId),
                        dbListDatabaseUsers(connectionId),
                        dbListPasswordReminders(connectionId),
                    ]);
                setAccessProfile(profile);
                setExtensions(extensionList);
                setRoles(roleList);
                setUsers(userList);
                setReminders(reminderList);
                setExtensionDetailsByName({});
                setRoleDetailsByName({});
            } catch (loadError) {
                setError(String(loadError));
            } finally {
                setIsLoading(false);
                setIsRefreshing(false);
            }
        },
        [connectionId]
    );

    useEffect(() => {
        markPostConnectRedirectConsumed();
    }, [markPostConnectRedirectConsumed]);

    useEffect(() => {
        if (!connectionId) {
            setIsLoading(false);
            return;
        }
        void loadManagementData(false);
    }, [connectionId, loadManagementData]);

    const filteredExtensions = useMemo(() => {
        const keyword = extensionSearch.trim().toLowerCase();
        return extensions
            .filter((extension) => {
                if (extensionFilter === "installed" && !extension.installed_version) return false;
                if (extensionFilter === "available" && extension.installed_version) return false;
                if (!keyword) return true;
                const haystack = `${extension.name} ${extension.comment ?? ""}`.toLowerCase();
                return haystack.includes(keyword);
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [extensions, extensionFilter, extensionSearch]);

    const activeExtension = useMemo(() => {
        if (filteredExtensions.length === 0) return null;
        if (!selectedExtensionName) return filteredExtensions[0];
        return (
            filteredExtensions.find((extension) => extension.name === selectedExtensionName) ??
            filteredExtensions[0]
        );
    }, [filteredExtensions, selectedExtensionName]);

    const activeExtensionDetail = activeExtension
        ? extensionDetailsByName[activeExtension.name] ?? null
        : null;

    const extensionVersionSelection = useMemo(() => {
        if (!activeExtensionDetail) return "__latest";
        if (extensionUpdateVersion === "__latest") return "__latest";
        if (activeExtensionDetail.available_versions.includes(extensionUpdateVersion)) {
            return extensionUpdateVersion;
        }
        return "__latest";
    }, [activeExtensionDetail, extensionUpdateVersion]);

    useEffect(() => {
        if (!connectionId || !activeExtension?.name) return;
        if (extensionDetailsByName[activeExtension.name]) return;

        let cancelled = false;
        setIsLoadingExtensionDetail(true);
        void dbGetExtensionDetail(connectionId, activeExtension.name)
            .then((detail) => {
                if (cancelled) return;
                setExtensionDetailsByName((current) => ({
                    ...current,
                    [detail.name]: detail,
                }));
            })
            .catch((detailError) => {
                if (cancelled) return;
                toast.error(String(detailError));
            })
            .finally(() => {
                if (cancelled) return;
                setIsLoadingExtensionDetail(false);
            });

        return () => {
            cancelled = true;
        };
    }, [connectionId, activeExtension?.name, extensionDetailsByName]);

    const visibleUsers = useMemo(
        () => users.filter((user) => !user.is_system_role),
        [users]
    );

    const filteredUsers = useMemo(() => {
        const keyword = userSearch.trim().toLowerCase();
        return visibleUsers
            .filter((user) => {
                if (!keyword) return true;
                const haystack = `${user.username} ${user.member_of.join(" ")}`.toLowerCase();
                return haystack.includes(keyword);
            })
            .sort((a, b) => a.username.localeCompare(b.username));
    }, [userSearch, visibleUsers]);

    const activeUser = useMemo(() => {
        if (filteredUsers.length === 0) return null;
        if (!selectedUsername) return filteredUsers[0];
        return filteredUsers.find((user) => user.username === selectedUsername) ?? filteredUsers[0];
    }, [filteredUsers, selectedUsername]);

    const reassignCandidates = useMemo(() => {
        if (!activeUser) return [];
        return visibleUsers
            .filter((user) => user.username !== activeUser.username && user.can_login)
            .map((user) => user.username);
    }, [activeUser, visibleUsers]);

    const effectiveDeleteReassignTo = useMemo(() => {
        if (deleteReassignTo === "__none") return "__none";
        return reassignCandidates.includes(deleteReassignTo)
            ? deleteReassignTo
            : "__none";
    }, [deleteReassignTo, reassignCandidates]);

    const assignableRoles = useMemo(
        () => roles.filter((role) => role.is_assignable && !role.is_system_role && !role.can_login),
        [roles]
    );
    const manageableRoleNames = useMemo(
        () => new Set(assignableRoles.map((role) => role.name)),
        [assignableRoles]
    );
    const customRoles = useMemo(
        () => roles.filter((role) => !role.can_login && !role.is_system_role),
        [roles]
    );
    const filteredRoles = useMemo(() => {
        const keyword = roleSearch.trim().toLowerCase();
        return customRoles
            .filter((role) => {
                if (!keyword) return true;
                return role.name.toLowerCase().includes(keyword);
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [customRoles, roleSearch]);
    const activeRole = useMemo(() => {
        if (filteredRoles.length === 0) return null;
        if (!selectedRoleName) return filteredRoles[0];
        return filteredRoles.find((role) => role.name === selectedRoleName) ?? filteredRoles[0];
    }, [filteredRoles, selectedRoleName]);
    const activeRoleDetail = activeRole ? roleDetailsByName[activeRole.name] ?? null : null;

    useEffect(() => {
        if (!connectionId || !activeRole?.name) return;
        if (roleDetailsByName[activeRole.name]) return;

        let cancelled = false;
        setIsLoadingRoleDetail(true);
        void dbGetDatabaseRoleDetail(connectionId, activeRole.name)
            .then((detail) => {
                if (cancelled) return;
                setRoleDetailsByName((current) => ({
                    ...current,
                    [detail.name]: detail,
                }));
            })
            .catch((detailError) => {
                if (cancelled) return;
                toast.error(String(detailError));
            })
            .finally(() => {
                if (cancelled) return;
                setIsLoadingRoleDetail(false);
            });

        return () => {
            cancelled = true;
        };
    }, [activeRole?.name, connectionId, roleDetailsByName]);

    const isCurrentConnectedUser =
        !!activeUser &&
        !!accessProfile &&
        activeUser.username === accessProfile.current_user;
    const selectedUserHasActiveRole =
        !!activeUser && !!activeRole && activeUser.member_of.includes(activeRole.name);

    const refreshExtensions = useCallback(async () => {
        if (!connectionId) return;
        const next = await dbListExtensions(connectionId);
        setExtensions(next);
    }, [connectionId]);

    const refreshUsersAndRoles = useCallback(async () => {
        if (!connectionId) return;
        const [nextUsers, nextRoles] = await Promise.all([
            dbListDatabaseUsers(connectionId),
            dbListDatabaseRoles(connectionId),
        ]);
        setUsers(nextUsers);
        setRoles(nextRoles);
        setRoleDetailsByName({});
    }, [connectionId]);

    const refreshReminders = useCallback(async () => {
        if (!connectionId) return;
        const next = await dbListPasswordReminders(connectionId);
        setReminders(next);
    }, [connectionId]);

    const reloadActiveExtensionDetail = useCallback(async () => {
        if (!connectionId || !activeExtension?.name) return;
        setIsLoadingExtensionDetail(true);
        try {
            const detail = await dbGetExtensionDetail(connectionId, activeExtension.name);
            setExtensionDetailsByName((current) => ({
                ...current,
                [detail.name]: detail,
            }));
        } finally {
            setIsLoadingExtensionDetail(false);
        }
    }, [activeExtension?.name, connectionId]);

    const reloadActiveRoleDetail = useCallback(async () => {
        if (!connectionId || !activeRole?.name) return;
        setIsLoadingRoleDetail(true);
        try {
            const detail = await dbGetDatabaseRoleDetail(connectionId, activeRole.name);
            setRoleDetailsByName((current) => ({
                ...current,
                [detail.name]: detail,
            }));
        } finally {
            setIsLoadingRoleDetail(false);
        }
    }, [activeRole?.name, connectionId]);

    const handleInstallExtension = async () => {
        if (!connectionId || !activeExtension) return;
        setExtensionActionBusy("install");
        try {
            await dbInstallExtension(connectionId, activeExtension.name);
            await Promise.all([refreshExtensions(), reloadActiveExtensionDetail()]);
            toast.success(`Installed extension: ${activeExtension.name}`);
        } catch (installError) {
            toast.error(String(installError));
        } finally {
            setExtensionActionBusy(null);
        }
    };

    const handleUninstallExtension = async () => {
        if (!connectionId || !activeExtension) return;
        if (!window.confirm(`Uninstall extension '${activeExtension.name}'?`)) return;

        setExtensionActionBusy("uninstall");
        try {
            await dbUninstallExtension(connectionId, activeExtension.name);
            await Promise.all([refreshExtensions(), reloadActiveExtensionDetail()]);
            toast.success(`Uninstalled extension: ${activeExtension.name}`);
        } catch (uninstallError) {
            toast.error(String(uninstallError));
        } finally {
            setExtensionActionBusy(null);
        }
    };

    const handleUpdateExtension = async () => {
        if (!connectionId || !activeExtension) return;
        setExtensionActionBusy("update");
        try {
            const targetVersion = extensionVersionSelection === "__latest" ? null : extensionVersionSelection;
            await dbUpdateExtension(connectionId, activeExtension.name, targetVersion);
            await Promise.all([refreshExtensions(), reloadActiveExtensionDetail()]);
            toast.success(`Updated extension: ${activeExtension.name}`);
        } catch (updateError) {
            toast.error(String(updateError));
        } finally {
            setExtensionActionBusy(null);
        }
    };

    const handleToggleRoleMembership = (roleName: string) => {
        setCreateUserForm((current) => {
            const exists = current.roleMemberships.includes(roleName);
            return {
                ...current,
                roleMemberships: exists
                    ? current.roleMemberships.filter((role) => role !== roleName)
                    : [...current.roleMemberships, roleName],
            };
        });
    };

    const handleToggleCreateRoleMembership = (roleName: string) => {
        setCreateRoleForm((current) => {
            const exists = current.memberships.includes(roleName);
            return {
                ...current,
                memberships: exists
                    ? current.memberships.filter((role) => role !== roleName)
                    : [...current.memberships, roleName],
            };
        });
    };

    const handleCreateRole = async () => {
        if (!connectionId || !accessProfile?.is_admin) return;
        const roleName = createRoleForm.roleName.trim();
        if (!roleName) {
            toast.error("Role name is required.");
            return;
        }

        setRoleActionBusy("create");
        try {
            const payload: CreateDatabaseRoleRequest = {
                role_name: roleName,
                inherit: createRoleForm.inherit,
                memberships: createRoleForm.memberships,
            };
            await dbCreateDatabaseRole(connectionId, payload);
            setCreateRoleForm(DEFAULT_CREATE_ROLE_FORM);
            setIsCreateRoleDialogOpen(false);
            await refreshUsersAndRoles();
            setSelectedRoleName(roleName);
            toast.success(`Custom role created: ${roleName}`);
        } catch (createError) {
            toast.error(String(createError));
        } finally {
            setRoleActionBusy(null);
        }
    };

    const openMembershipManagementDialog = () => {
        if (!activeUser) return;
        setMembershipDraft(activeUser.member_of);
        setMembershipWithAdminOption(false);
        setIsManageMembershipDialogOpen(true);
    };

    const handleToggleMembershipDraft = (roleName: string) => {
        setMembershipDraft((current) => {
            const exists = current.includes(roleName);
            if (exists) return current.filter((role) => role !== roleName);
            return [...current, roleName];
        });
    };

    const handleSaveMembershipDraft = async () => {
        if (!connectionId || !activeUser || !accessProfile?.is_admin) return;
        const currentMemberships = new Set(activeUser.member_of);
        const nextMemberships = new Set(membershipDraft);

        const toGrant = Array.from(nextMemberships).filter(
            (role) => !currentMemberships.has(role) && manageableRoleNames.has(role)
        );
        const toRevoke = Array.from(currentMemberships).filter(
            (role) => !nextMemberships.has(role) && manageableRoleNames.has(role)
        );

        if (toGrant.length === 0 && toRevoke.length === 0) {
            setIsManageMembershipDialogOpen(false);
            return;
        }

        setRoleActionBusy("membership");
        try {
            await Promise.all([
                ...toGrant.map((role) =>
                    dbGrantDatabaseRoleMembership(
                        connectionId,
                        role,
                        activeUser.username,
                        membershipWithAdminOption
                    )
                ),
                ...toRevoke.map((role) =>
                    dbRevokeDatabaseRoleMembership(connectionId, role, activeUser.username)
                ),
            ]);
            await Promise.all([refreshUsersAndRoles(), reloadActiveRoleDetail()]);
            setIsManageMembershipDialogOpen(false);
            toast.success(`Updated memberships for ${activeUser.username}.`);
        } catch (membershipError) {
            toast.error(String(membershipError));
        } finally {
            setRoleActionBusy(null);
        }
    };

    const handleGrantActiveRoleToSelectedUser = async () => {
        if (!connectionId || !activeRole || !activeUser) return;
        setRoleActionBusy("membership");
        try {
            await dbGrantDatabaseRoleMembership(
                connectionId,
                activeRole.name,
                activeUser.username,
                false
            );
            await Promise.all([refreshUsersAndRoles(), reloadActiveRoleDetail()]);
            toast.success(`Granted ${activeRole.name} to ${activeUser.username}.`);
        } catch (grantError) {
            toast.error(String(grantError));
        } finally {
            setRoleActionBusy(null);
        }
    };

    const handleRevokeActiveRoleFromSelectedUser = async () => {
        if (!connectionId || !activeRole || !activeUser) return;
        setRoleActionBusy("membership");
        try {
            await dbRevokeDatabaseRoleMembership(connectionId, activeRole.name, activeUser.username);
            await Promise.all([refreshUsersAndRoles(), reloadActiveRoleDetail()]);
            toast.success(`Revoked ${activeRole.name} from ${activeUser.username}.`);
        } catch (revokeError) {
            toast.error(String(revokeError));
        } finally {
            setRoleActionBusy(null);
        }
    };

    const handleCreateUser = async () => {
        if (!connectionId || !accessProfile?.is_admin) return;
        if (!createUserForm.username.trim() || !createUserForm.password) {
            toast.error("Username and password are required.");
            return;
        }

        setUserActionBusy("create");
        try {
            const payload: CreateDatabaseUserRequest = {
                username: createUserForm.username.trim(),
                password: createUserForm.password,
                role_memberships: createUserForm.roleMemberships,
                can_create_db: createUserForm.canCreateDb,
                can_create_role: createUserForm.canCreateRole,
                is_superuser: createUserForm.isSuperuser,
                inherit: createUserForm.inherit,
                replication: createUserForm.replication,
                bypass_rls: createUserForm.bypassRls,
                valid_until: createUserForm.validUntil.trim() || null,
                password_reminder: createUserForm.passwordReminder.trim() || null,
            };
            await dbCreateDatabaseUser(connectionId, payload);

            setCreateUserForm(DEFAULT_CREATE_USER_FORM);
            await Promise.all([refreshUsersAndRoles(), refreshReminders()]);
            toast.success("Database user created.");
        } catch (createError) {
            toast.error(String(createError));
        } finally {
            setUserActionBusy(null);
        }
    };

    const handleToggleUserLogin = async () => {
        if (!connectionId || !activeUser) return;
        const nextCanLogin = !activeUser.can_login;
        setUserActionBusy("toggle");
        try {
            await dbSetDatabaseUserLogin(connectionId, activeUser.username, nextCanLogin);
            await refreshUsersAndRoles();
            toast.success(
                `${activeUser.username} is now ${nextCanLogin ? "active" : "inactive"}.`
            );
        } catch (toggleError) {
            toast.error(String(toggleError));
        } finally {
            setUserActionBusy(null);
        }
    };

    const handleResetPassword = async () => {
        if (!connectionId || !activeUser) return;
        if (newPassword.length < 8) {
            toast.error("New password must be at least 8 characters.");
            return;
        }

        setUserActionBusy("password");
        try {
            await dbSetDatabaseUserPassword(connectionId, activeUser.username, newPassword);
            setNewPassword("");
            toast.success(`Password updated for ${activeUser.username}.`);
        } catch (passwordError) {
            toast.error(String(passwordError));
        } finally {
            setUserActionBusy(null);
        }
    };

    const handleDeleteUser = async () => {
        if (!connectionId || !activeUser) return;

        const confirmMessage =
            effectiveDeleteReassignTo === "__none"
                ? `Delete user '${activeUser.username}'? This cannot be undone.`
                : `Delete user '${activeUser.username}' and reassign owned objects to '${effectiveDeleteReassignTo}'?`;
        if (!window.confirm(confirmMessage)) return;

        setUserActionBusy("delete");
        try {
            await dbDeleteDatabaseUser(
                connectionId,
                activeUser.username,
                effectiveDeleteReassignTo === "__none" ? null : effectiveDeleteReassignTo
            );
            await refreshUsersAndRoles();
            toast.success(`Deleted user: ${activeUser.username}`);
        } catch (deleteError) {
            toast.error(String(deleteError));
        } finally {
            setUserActionBusy(null);
        }
    };

    const handleDeleteReminder = async (id: string) => {
        if (!connectionId) return;
        try {
            const next = await dbDeletePasswordReminder(connectionId, id);
            setReminders(next);
            toast.success("Reminder removed.");
        } catch (deleteError) {
            toast.error(String(deleteError));
        }
    };

    if (!isConnected || !connectionId) {
        return (
            <div className="flex h-screen items-center justify-center bg-background px-6">
                <div className="w-full max-w-md rounded-2xl border border-border/40 bg-card/40 p-6 text-center">
                    <h1 className="text-lg font-semibold">No active database connection</h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Connect to a PostgreSQL database to manage extensions and users.
                    </p>
                    <Button asChild className="mt-5">
                        <Link href="/">Back to Connections</Link>
                    </Button>
                </div>
            </div>
        );
    }

    const installedCount = extensions.filter((extension) => !!extension.installed_version).length;

    return (
        <div className="min-h-screen bg-background text-foreground">
            <div className="pointer-events-none fixed inset-0 overflow-hidden">
                <div className="absolute -top-28 -left-28 h-80 w-80 rounded-full bg-emerald-500/5 blur-3xl" />
                <div className="absolute -bottom-32 -right-28 h-80 w-80 rounded-full bg-cyan-500/5 blur-3xl" />
            </div>

            <header className="sticky top-0 z-20 border-b border-border/30 bg-background/90 backdrop-blur-sm">
                <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
                    <div className="flex items-center gap-3">
                        <Image src="/logo.png" alt="" width={24} height={24} className="h-6 w-6 rounded-md object-contain" />
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                                {APP_NAME}
                            </span>
                            <span className="hidden text-xs text-muted-foreground/80 sm:inline">
                                Extensions & User Management
                            </span>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Badge variant="outline" className="hidden h-6 border-border/40 px-2 font-mono text-[10px] sm:inline-flex">
                            {databaseName}
                        </Badge>
                        {pgVersion && (
                            <Badge variant="outline" className="hidden h-6 border-border/40 px-2 font-mono text-[10px] md:inline-flex">
                                PG {pgVersion}
                            </Badge>
                        )}
                        <Button variant="ghost" size="sm" asChild className="h-7 px-2.5 text-xs">
                            <Link href="/">
                                <ArrowLeft className="h-3.5 w-3.5" />
                                Workspace
                            </Link>
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => disconnect()}
                        >
                            Disconnect
                        </Button>
                    </div>
                </div>
            </header>

            <main className="relative mx-auto max-w-7xl px-4 py-6">
                <div className="grid gap-3 md:grid-cols-4">
                    <SummaryCard
                        title="Connected role"
                        value={accessProfile?.current_user ?? "Loading..."}
                        icon={<KeyRound className="h-3.5 w-3.5 text-emerald-400" />}
                    />
                    <SummaryCard
                        title="Admin capability"
                        value={accessProfile?.is_admin ? "Enabled" : "Read-only"}
                        icon={<ShieldCheck className="h-3.5 w-3.5 text-cyan-400" />}
                    />
                    <SummaryCard
                        title="Installed extensions"
                        value={`${installedCount}`}
                        icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                    />
                    <SummaryCard
                        title="Managed users"
                        value={`${visibleUsers.length}`}
                        icon={<UserCog className="h-3.5 w-3.5 text-cyan-400" />}
                    />
                </div>

                <Tabs
                    value={activeTab}
                    onValueChange={(value) => setActiveTab(value as TabKey)}
                    className="mt-5"
                >
                    <TabsList className="h-9 bg-muted/40 p-1">
                        <TabsTrigger value="extensions" className="text-xs">
                            <Wrench className="h-3.5 w-3.5" />
                            Extensions
                        </TabsTrigger>
                        <TabsTrigger value="users" className="text-xs">
                            <UserRound className="h-3.5 w-3.5" />
                            Users
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="extensions" className="mt-4">
                        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
                            <section className="rounded-2xl border border-border/35 bg-card/35 p-4 backdrop-blur-sm">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                        <h2 className="text-sm font-semibold">Extensions</h2>
                                        <p className="text-xs text-muted-foreground">
                                            Browse all available extensions and installed status.
                                        </p>
                                    </div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-8 gap-1.5 text-xs"
                                        onClick={() => void loadManagementData(true)}
                                        disabled={isLoading || isRefreshing}
                                    >
                                        <RefreshCw className={cn("h-3.5 w-3.5", (isLoading || isRefreshing) && "animate-spin")} />
                                        Refresh
                                    </Button>
                                </div>

                                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px]">
                                    <div className="relative">
                                        <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground/60" />
                                        <Input
                                            value={extensionSearch}
                                            onChange={(event) => setExtensionSearch(event.target.value)}
                                            placeholder="Search extensions..."
                                            className="h-9 pl-9 text-sm"
                                        />
                                    </div>
                                    <Select
                                        value={extensionFilter}
                                        onValueChange={(value) => setExtensionFilter(value as ExtensionFilter)}
                                    >
                                        <SelectTrigger className="h-9 w-full text-xs">
                                            <SelectValue placeholder="Filter" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="all">All extensions</SelectItem>
                                            <SelectItem value="installed">Installed only</SelectItem>
                                            <SelectItem value="available">Not installed</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="mt-3 rounded-xl border border-border/35 bg-background/40">
                                    <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-2 border-b border-border/30 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                        <span>Name</span>
                                        <span className="text-right">Status</span>
                                    </div>
                                    <ScrollArea className="h-[430px]">
                                        {isLoading ? (
                                            <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                Loading extensions...
                                            </div>
                                        ) : filteredExtensions.length === 0 ? (
                                            <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
                                                No extensions match your search.
                                            </div>
                                        ) : (
                                            filteredExtensions.map((extension) => {
                                                const active = activeExtension?.name === extension.name;
                                                return (
                                                    <button
                                                        key={extension.name}
                                                        type="button"
                                                        onClick={() => setSelectedExtensionName(extension.name)}
                                                        className={cn(
                                                            "grid w-full grid-cols-[minmax(0,1fr)_120px] items-center gap-2 border-b border-border/25 px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/20",
                                                            active && "bg-emerald-500/10"
                                                        )}
                                                    >
                                                        <div className="min-w-0">
                                                            <p className="truncate font-mono text-xs">{extension.name}</p>
                                                            <p className="truncate text-[11px] text-muted-foreground">
                                                                {extension.comment ?? "No description"}
                                                            </p>
                                                        </div>
                                                        <div className="flex justify-end">
                                                            {extension.installed_version ? (
                                                                <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                                    Installed
                                                                </Badge>
                                                            ) : (
                                                                <Badge variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                                    Available
                                                                </Badge>
                                                            )}
                                                        </div>
                                                    </button>
                                                );
                                            })
                                        )}
                                    </ScrollArea>
                                </div>
                            </section>

                            <section className="rounded-2xl border border-border/35 bg-card/35 p-4 backdrop-blur-sm">
                                <h2 className="text-sm font-semibold">Extension Detail</h2>
                                <p className="text-xs text-muted-foreground">
                                    Install, update, or uninstall from a single panel.
                                </p>

                                {!activeExtension ? (
                                    <div className="mt-4 rounded-lg border border-border/35 bg-background/30 px-3 py-2 text-xs text-muted-foreground">
                                        Select an extension to view full details.
                                    </div>
                                ) : (
                                    <>
                                        <div className="mt-4 rounded-lg border border-border/35 bg-background/30 p-3">
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="min-w-0">
                                                    <p className="truncate font-mono text-sm">{activeExtension.name}</p>
                                                    <p className="mt-1 text-xs text-muted-foreground">
                                                        {activeExtension.comment ?? "No extension description available."}
                                                    </p>
                                                </div>
                                                {activeExtension.installed_version ? (
                                                    <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                        Installed
                                                    </Badge>
                                                ) : (
                                                    <Badge variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                        Available
                                                    </Badge>
                                                )}
                                            </div>

                                            {(activeExtensionDetail || isLoadingExtensionDetail) && (
                                                <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                                                    {isLoadingExtensionDetail ? (
                                                        <p className="flex items-center gap-1.5">
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                            Loading details...
                                                        </p>
                                                    ) : (
                                                        <>
                                                            <p>
                                                                Installed version: {activeExtensionDetail?.installed_version ?? "Not installed"}
                                                            </p>
                                                            <p>
                                                                Default version: {activeExtensionDetail?.default_version ?? "Unknown"}
                                                            </p>
                                                            {activeExtensionDetail?.installed_owner && (
                                                                <p>
                                                                    Owner: {activeExtensionDetail.installed_owner}
                                                                    {activeExtensionDetail.installed_schema
                                                                        ? `  ·  Schema: ${activeExtensionDetail.installed_schema}`
                                                                        : ""}
                                                                </p>
                                                            )}
                                                            <p>
                                                                Trusted: {activeExtensionDetail?.trusted ? "Yes" : "No"}
                                                                {activeExtensionDetail?.requires_superuser
                                                                    ? "  ·  Some versions require superuser"
                                                                    : ""}
                                                            </p>
                                                        </>
                                                    )}
                                                </div>
                                            )}
                                        </div>

                                        <div className="mt-3 rounded-lg border border-border/35 bg-background/30 p-3">
                                            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                                Actions
                                            </p>

                                            <div className="mt-2 flex flex-wrap gap-2">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 gap-1.5 text-xs"
                                                    onClick={() => setIsExtensionDetailDialogOpen(true)}
                                                >
                                                    <PanelRightOpen className="h-3.5 w-3.5" />
                                                    Full details
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    className="h-8 text-xs"
                                                    onClick={handleInstallExtension}
                                                    disabled={
                                                        !activeExtensionDetail?.can_install ||
                                                        !!activeExtension.installed_version ||
                                                        !!extensionActionBusy
                                                    }
                                                >
                                                    {extensionActionBusy === "install" ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        "Install"
                                                    )}
                                                </Button>

                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 text-xs"
                                                    onClick={handleUpdateExtension}
                                                    disabled={
                                                        !activeExtensionDetail?.can_update ||
                                                        !activeExtension.installed_version ||
                                                        !!extensionActionBusy
                                                    }
                                                >
                                                    {extensionActionBusy === "update" ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        "Update"
                                                    )}
                                                </Button>

                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 border-destructive/40 text-xs text-destructive hover:bg-destructive/10"
                                                    onClick={handleUninstallExtension}
                                                    disabled={
                                                        !activeExtensionDetail?.can_uninstall ||
                                                        !activeExtension.installed_version ||
                                                        !!extensionActionBusy
                                                    }
                                                >
                                                    {extensionActionBusy === "uninstall" ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        "Uninstall"
                                                    )}
                                                </Button>
                                            </div>

                                            <div className="mt-2">
                                                <Select
                                                    value={extensionVersionSelection}
                                                    onValueChange={setExtensionUpdateVersion}
                                                >
                                                    <SelectTrigger className="h-8 w-full text-xs">
                                                        <SelectValue placeholder="Target version" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="__latest">Latest/default version</SelectItem>
                                                        {(activeExtensionDetail?.available_versions ?? []).map((version) => (
                                                            <SelectItem key={version} value={version}>
                                                                {version}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            <div className="mt-2 space-y-1 text-[11px] text-amber-300">
                                                {activeExtensionDetail?.install_block_reason && (
                                                    <p>Install: {activeExtensionDetail.install_block_reason}</p>
                                                )}
                                                {activeExtensionDetail?.update_block_reason && (
                                                    <p>Update: {activeExtensionDetail.update_block_reason}</p>
                                                )}
                                                {activeExtensionDetail?.uninstall_block_reason && (
                                                    <p>Uninstall: {activeExtensionDetail.uninstall_block_reason}</p>
                                                )}
                                            </div>
                                        </div>

                                        <div className="mt-3 rounded-lg border border-border/35 bg-background/30 p-3">
                                            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                                Available versions
                                            </p>
                                            <div className="mt-2 flex flex-wrap gap-1.5">
                                                {(activeExtensionDetail?.available_versions ?? []).length === 0 ? (
                                                    <span className="text-xs text-muted-foreground">No version metadata</span>
                                                ) : (
                                                    (activeExtensionDetail?.available_versions ?? []).map((version) => (
                                                        <Badge key={version} variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                            {version}
                                                        </Badge>
                                                    ))
                                                )}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </section>
                        </div>
                    </TabsContent>

                    <TabsContent value="users" className="mt-4">
                        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                            <section className="rounded-2xl border border-border/35 bg-card/35 p-4 backdrop-blur-sm">
                                <div className="flex items-center justify-between gap-2">
                                    <div>
                                        <h2 className="text-sm font-semibold">Database Users</h2>
                                        <p className="text-xs text-muted-foreground">
                                            Active/inactive accounts with role memberships.
                                        </p>
                                    </div>
                                    <Badge variant="outline" className="h-6 border-border/40 px-2 text-[10px]">
                                        {filteredUsers.length}
                                    </Badge>
                                </div>

                                <div className="mt-3 relative">
                                    <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground/60" />
                                    <Input
                                        value={userSearch}
                                        onChange={(event) => setUserSearch(event.target.value)}
                                        placeholder="Search users..."
                                        className="h-9 pl-9 text-sm"
                                    />
                                </div>

                                <div className="mt-3 rounded-xl border border-border/35 bg-background/40">
                                    <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-2 border-b border-border/30 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                        <span>User</span>
                                        <span className="text-right">State</span>
                                    </div>
                                    <ScrollArea className="h-[430px]">
                                        {isLoading ? (
                                            <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                Loading users...
                                            </div>
                                        ) : filteredUsers.length === 0 ? (
                                            <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
                                                No users match your search.
                                            </div>
                                        ) : (
                                            filteredUsers.map((user) => {
                                                const active = activeUser?.username === user.username;
                                                return (
                                                    <button
                                                        key={user.username}
                                                        type="button"
                                                        onClick={() => setSelectedUsername(user.username)}
                                                        className={cn(
                                                            "grid w-full grid-cols-[minmax(0,1fr)_120px] items-center gap-2 border-b border-border/25 px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/20",
                                                            active && "bg-cyan-500/10"
                                                        )}
                                                    >
                                                        <div className="min-w-0">
                                                            <p className="truncate font-mono text-xs">{user.username}</p>
                                                            <div className="mt-1 flex flex-wrap gap-1">
                                                                {user.is_superuser && (
                                                                    <Badge variant="outline" className="h-4 border-cyan-500/40 bg-cyan-500/10 px-1 text-[9px] text-cyan-300">
                                                                        Superuser
                                                                    </Badge>
                                                                )}
                                                                {user.can_create_role && (
                                                                    <Badge variant="outline" className="h-4 border-emerald-500/40 bg-emerald-500/10 px-1 text-[9px] text-emerald-300">
                                                                        CREATEROLE
                                                                    </Badge>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className="flex justify-end">
                                                            {user.can_login ? (
                                                                <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                                    Active
                                                                </Badge>
                                                            ) : (
                                                                <Badge variant="outline" className="h-5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-300">
                                                                    Inactive
                                                                </Badge>
                                                            )}
                                                        </div>
                                                    </button>
                                                );
                                            })
                                        )}
                                    </ScrollArea>
                                </div>
                            </section>

                            <section className="rounded-2xl border border-border/35 bg-card/35 p-4 backdrop-blur-sm">
                                <h2 className="text-sm font-semibold">User Detail & Actions</h2>
                                <p className="text-xs text-muted-foreground">
                                    Manage selected account and create new users with RBAC.
                                </p>

                                {!activeUser ? (
                                    <div className="mt-4 rounded-lg border border-border/35 bg-background/30 px-3 py-2 text-xs text-muted-foreground">
                                        Select a user to manage account state and security actions.
                                    </div>
                                ) : (
                                    <>
                                        <div className="mt-4 rounded-lg border border-border/35 bg-background/30 p-3">
                                            <div className="flex items-start justify-between gap-2">
                                                <div>
                                                    <p className="font-mono text-sm">{activeUser.username}</p>
                                                    <p className="mt-1 text-xs text-muted-foreground">
                                                        Valid until: {activeUser.valid_until ?? "No expiry"}
                                                    </p>
                                                </div>
                                                {activeUser.can_login ? (
                                                    <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                        Active
                                                    </Badge>
                                                ) : (
                                                    <Badge variant="outline" className="h-5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-300">
                                                        Inactive
                                                    </Badge>
                                                )}
                                            </div>

                                            <div className="mt-3 flex flex-wrap gap-1.5">
                                                {activeUser.is_superuser && (
                                                    <Badge variant="outline" className="h-5 border-cyan-500/40 bg-cyan-500/10 px-1.5 text-[10px] text-cyan-300">
                                                        SUPERUSER
                                                    </Badge>
                                                )}
                                                {activeUser.can_create_role && (
                                                    <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                        CREATEROLE
                                                    </Badge>
                                                )}
                                                {activeUser.can_create_db && (
                                                    <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                        CREATEDB
                                                    </Badge>
                                                )}
                                                {activeUser.can_replicate && (
                                                    <Badge variant="outline" className="h-5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-300">
                                                        REPLICATION
                                                    </Badge>
                                                )}
                                                {activeUser.can_bypass_rls && (
                                                    <Badge variant="outline" className="h-5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-300">
                                                        BYPASSRLS
                                                    </Badge>
                                                )}
                                            </div>

                                            <div className="mt-3">
                                                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                                    Memberships
                                                </p>
                                                <div className="mt-1 flex flex-wrap gap-1">
                                                    {activeUser.member_of.length === 0 ? (
                                                        <span className="text-xs text-muted-foreground">No memberships</span>
                                                    ) : (
                                                        activeUser.member_of.map((roleName) => (
                                                            <Badge key={roleName} variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                                {roleName}
                                                            </Badge>
                                                        ))
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="mt-3 rounded-lg border border-border/35 bg-background/30 p-3">
                                            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                                Account actions
                                            </p>
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 gap-1.5 text-xs"
                                                    onClick={() => setIsUserDetailDialogOpen(true)}
                                                >
                                                    <PanelRightOpen className="h-3.5 w-3.5" />
                                                    Full profile
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 gap-1.5 text-xs"
                                                    onClick={openMembershipManagementDialog}
                                                    disabled={!accessProfile?.is_admin || roleActionBusy !== null}
                                                >
                                                    <UsersRound className="h-3.5 w-3.5" />
                                                    Manage memberships
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 gap-1.5 text-xs"
                                                    onClick={handleToggleUserLogin}
                                                    disabled={
                                                        userActionBusy !== null ||
                                                        !accessProfile?.is_admin ||
                                                        isCurrentConnectedUser
                                                    }
                                                >
                                                    {userActionBusy === "toggle" ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : activeUser.can_login ? (
                                                        <>
                                                            <UserRoundX className="h-3.5 w-3.5" />
                                                            Set inactive
                                                        </>
                                                    ) : (
                                                        <>
                                                            <UserRound className="h-3.5 w-3.5" />
                                                            Set active
                                                        </>
                                                    )}
                                                </Button>
                                            </div>

                                            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px]">
                                                <Input
                                                    type="password"
                                                    value={newPassword}
                                                    onChange={(event) => setNewPassword(event.target.value)}
                                                    placeholder="New password"
                                                    className="h-8 text-xs"
                                                />
                                                <Button
                                                    size="sm"
                                                    className="h-8 text-xs"
                                                    onClick={handleResetPassword}
                                                    disabled={userActionBusy !== null || !accessProfile?.is_admin}
                                                >
                                                    {userActionBusy === "password" ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        "Reset password"
                                                    )}
                                                </Button>
                                            </div>

                                            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px]">
                                                <Select value={effectiveDeleteReassignTo} onValueChange={setDeleteReassignTo}>
                                                    <SelectTrigger className="h-8 w-full text-xs">
                                                        <SelectValue placeholder="Reassign owned objects" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="__none">Delete only (no reassignment)</SelectItem>
                                                        {reassignCandidates.map((candidate) => (
                                                            <SelectItem key={candidate} value={candidate}>
                                                                Reassign to {candidate}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 border-destructive/40 text-xs text-destructive hover:bg-destructive/10"
                                                    onClick={handleDeleteUser}
                                                    disabled={
                                                        userActionBusy !== null ||
                                                        !accessProfile?.is_admin ||
                                                        isCurrentConnectedUser
                                                    }
                                                >
                                                    {userActionBusy === "delete" ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        "Delete user"
                                                    )}
                                                </Button>
                                            </div>

                                            {isCurrentConnectedUser && (
                                                <p className="mt-2 text-[11px] text-amber-300">
                                                    Login state and delete actions are blocked for the current connected user.
                                                </p>
                                            )}
                                        </div>
                                    </>
                                )}

                                <Separator className="my-4" />

                                <div className="rounded-lg border border-border/35 bg-background/30 p-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <div>
                                            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                                Custom RBAC roles
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                Create NOLOGIN roles and manage memberships.
                                            </p>
                                        </div>
                                        <Button
                                            size="sm"
                                            className="h-8 gap-1.5 text-xs"
                                            onClick={() => setIsCreateRoleDialogOpen(true)}
                                            disabled={!accessProfile?.is_admin || roleActionBusy !== null}
                                        >
                                            <UserPlus className="h-3.5 w-3.5" />
                                            Create role
                                        </Button>
                                    </div>

                                    <div className="mt-2 relative">
                                        <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground/60" />
                                        <Input
                                            value={roleSearch}
                                            onChange={(event) => setRoleSearch(event.target.value)}
                                            placeholder="Search custom roles..."
                                            className="h-8 pl-9 text-xs"
                                        />
                                    </div>

                                    <div className="mt-2 rounded border border-border/30">
                                        <ScrollArea className="h-32">
                                            {filteredRoles.length === 0 ? (
                                                <p className="px-2 py-2 text-xs text-muted-foreground">
                                                    No custom roles found.
                                                </p>
                                            ) : (
                                                filteredRoles.map((role) => {
                                                    const selected = activeRole?.name === role.name;
                                                    return (
                                                        <button
                                                            key={role.name}
                                                            type="button"
                                                            onClick={() => setSelectedRoleName(role.name)}
                                                            className={cn(
                                                                "flex w-full items-center justify-between border-b border-border/20 px-2 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted/20",
                                                                selected && "bg-cyan-500/10"
                                                            )}
                                                        >
                                                            <span className="font-mono">{role.name}</span>
                                                            <div className="flex items-center gap-1">
                                                                {role.is_assignable && (
                                                                    <Badge variant="outline" className="h-4 border-emerald-500/40 bg-emerald-500/10 px-1 text-[9px] text-emerald-300">
                                                                        Manageable
                                                                    </Badge>
                                                                )}
                                                            </div>
                                                        </button>
                                                    );
                                                })
                                            )}
                                        </ScrollArea>
                                    </div>

                                    {activeRole ? (
                                        <div className="mt-2 rounded border border-border/30 bg-card/20 p-2">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="font-mono text-xs">{activeRole.name}</p>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-7 gap-1.5 text-[11px]"
                                                    onClick={() => setIsRoleDetailDialogOpen(true)}
                                                >
                                                    <PanelRightOpen className="h-3 w-3" />
                                                    Full detail
                                                </Button>
                                            </div>
                                            {activeUser && (
                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    <Button
                                                        size="sm"
                                                        className="h-7 gap-1.5 text-[11px]"
                                                        onClick={handleGrantActiveRoleToSelectedUser}
                                                        disabled={
                                                            roleActionBusy !== null ||
                                                            !accessProfile?.is_admin ||
                                                            selectedUserHasActiveRole
                                                        }
                                                    >
                                                        <UserCheck className="h-3 w-3" />
                                                        Grant to {activeUser.username}
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        className="h-7 gap-1.5 text-[11px]"
                                                        onClick={handleRevokeActiveRoleFromSelectedUser}
                                                        disabled={
                                                            roleActionBusy !== null ||
                                                            !accessProfile?.is_admin ||
                                                            !selectedUserHasActiveRole
                                                        }
                                                    >
                                                        <CircleSlash className="h-3 w-3" />
                                                        Revoke from {activeUser.username}
                                                    </Button>
                                                </div>
                                            )}
                                            {(activeRoleDetail?.manage_block_reason || isLoadingRoleDetail) && (
                                                <p className="mt-2 text-[11px] text-amber-300">
                                                    {isLoadingRoleDetail
                                                        ? "Loading role detail..."
                                                        : activeRoleDetail?.manage_block_reason}
                                                </p>
                                            )}
                                        </div>
                                    ) : null}
                                </div>

                                <Separator className="my-4" />

                                <div className="rounded-lg border border-border/35 bg-background/30 p-3">
                                    <div className="flex items-center justify-between">
                                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                            Create user
                                        </p>
                                        <Badge variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                            {accessProfile?.is_admin ? "Admin mode" : "Read-only"}
                                        </Badge>
                                    </div>

                                    {!accessProfile?.is_admin ? (
                                        <p className="mt-2 text-xs text-amber-300">
                                            Current role requires `CREATEROLE` or `SUPERUSER` to create users.
                                        </p>
                                    ) : (
                                        <>
                                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                                <Input
                                                    value={createUserForm.username}
                                                    onChange={(event) =>
                                                        setCreateUserForm((current) => ({
                                                            ...current,
                                                            username: event.target.value,
                                                        }))
                                                    }
                                                    placeholder="username"
                                                    className="h-8 text-xs"
                                                />
                                                <Input
                                                    type="password"
                                                    value={createUserForm.password}
                                                    onChange={(event) =>
                                                        setCreateUserForm((current) => ({
                                                            ...current,
                                                            password: event.target.value,
                                                        }))
                                                    }
                                                    placeholder="password"
                                                    className="h-8 text-xs"
                                                />
                                                <Input
                                                    value={createUserForm.validUntil}
                                                    onChange={(event) =>
                                                        setCreateUserForm((current) => ({
                                                            ...current,
                                                            validUntil: event.target.value,
                                                        }))
                                                    }
                                                    placeholder="valid until (optional)"
                                                    className="h-8 text-xs sm:col-span-2"
                                                />
                                            </div>

                                            <div className="mt-2 rounded border border-border/30 p-2">
                                                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                                    Role attributes
                                                </p>
                                                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                                                    <ToggleCheckbox
                                                        label="Can create DB"
                                                        checked={createUserForm.canCreateDb}
                                                        onChange={(checked) =>
                                                            setCreateUserForm((current) => ({ ...current, canCreateDb: checked }))
                                                        }
                                                    />
                                                    <ToggleCheckbox
                                                        label="Can create role"
                                                        checked={createUserForm.canCreateRole}
                                                        onChange={(checked) =>
                                                            setCreateUserForm((current) => ({ ...current, canCreateRole: checked }))
                                                        }
                                                    />
                                                    <ToggleCheckbox
                                                        label="Inherit grants"
                                                        checked={createUserForm.inherit}
                                                        onChange={(checked) =>
                                                            setCreateUserForm((current) => ({ ...current, inherit: checked }))
                                                        }
                                                    />
                                                    <ToggleCheckbox
                                                        label="Superuser"
                                                        checked={createUserForm.isSuperuser}
                                                        disabled={!accessProfile?.is_superuser}
                                                        onChange={(checked) =>
                                                            setCreateUserForm((current) => ({ ...current, isSuperuser: checked }))
                                                        }
                                                    />
                                                    <ToggleCheckbox
                                                        label="Replication"
                                                        checked={createUserForm.replication}
                                                        disabled={!accessProfile?.is_superuser}
                                                        onChange={(checked) =>
                                                            setCreateUserForm((current) => ({ ...current, replication: checked }))
                                                        }
                                                    />
                                                    <ToggleCheckbox
                                                        label="Bypass RLS"
                                                        checked={createUserForm.bypassRls}
                                                        disabled={!accessProfile?.is_superuser}
                                                        onChange={(checked) =>
                                                            setCreateUserForm((current) => ({ ...current, bypassRls: checked }))
                                                        }
                                                    />
                                                </div>
                                            </div>

                                            <div className="mt-2 rounded border border-border/30 p-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                                        RBAC memberships
                                                    </p>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-6 px-1.5 text-[10px]"
                                                        onClick={() => setIsCreateRoleDialogOpen(true)}
                                                    >
                                                        New custom role
                                                    </Button>
                                                </div>
                                                <ScrollArea className="mt-1 h-24">
                                                    {assignableRoles.length === 0 ? (
                                                        <p className="text-xs text-muted-foreground">No assignable roles for this admin context.</p>
                                                    ) : (
                                                        <div className="space-y-1">
                                                            {assignableRoles.map((role) => (
                                                                <label
                                                                    key={role.name}
                                                                    className="flex cursor-pointer items-center justify-between rounded px-1 py-1 text-xs hover:bg-muted/20"
                                                                >
                                                                    <span className="font-mono">{role.name}</span>
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={createUserForm.roleMemberships.includes(role.name)}
                                                                        onChange={() => handleToggleRoleMembership(role.name)}
                                                                        className="h-3.5 w-3.5"
                                                                    />
                                                                </label>
                                                            ))}
                                                        </div>
                                                    )}
                                                </ScrollArea>
                                            </div>

                                            <Input
                                                value={createUserForm.passwordReminder}
                                                onChange={(event) =>
                                                    setCreateUserForm((current) => ({
                                                        ...current,
                                                        passwordReminder: event.target.value,
                                                    }))
                                                }
                                                placeholder="Password reminder (local only)"
                                                className="mt-2 h-8 text-xs"
                                            />

                                            <Button
                                                className="mt-2 h-8 w-full gap-1.5 text-xs"
                                                onClick={handleCreateUser}
                                                disabled={userActionBusy !== null}
                                            >
                                                {userActionBusy === "create" ? (
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                ) : (
                                                    <UserPlus className="h-3.5 w-3.5" />
                                                )}
                                                Create user
                                            </Button>
                                        </>
                                    )}
                                </div>

                                <Separator className="my-4" />

                                <div>
                                    <p className="text-xs font-semibold">Local password reminders</p>
                                    <ScrollArea className="mt-2 h-28 rounded-lg border border-border/35 bg-background/30 p-2">
                                        {reminders.length === 0 ? (
                                            <p className="px-1 py-1 text-xs text-muted-foreground">
                                                No reminders saved for this connection target.
                                            </p>
                                        ) : (
                                            <div className="space-y-2">
                                                {reminders.map((reminder) => (
                                                    <div
                                                        key={reminder.id}
                                                        className="flex items-start justify-between gap-2 rounded border border-border/30 bg-card/20 p-2"
                                                    >
                                                        <div className="min-w-0">
                                                            <p className="text-xs font-mono">{reminder.username}</p>
                                                            <p className="truncate text-[11px] text-muted-foreground">
                                                                {reminder.reminder}
                                                            </p>
                                                        </div>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                                                            onClick={() => void handleDeleteReminder(reminder.id)}
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </ScrollArea>
                                </div>
                            </section>
                        </div>
                    </TabsContent>
                </Tabs>

                <Dialog
                    open={isExtensionDetailDialogOpen}
                    onOpenChange={setIsExtensionDetailDialogOpen}
                >
                    <DialogContent className="max-w-2xl border-border/40 bg-card/95">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-sm">
                                <Wrench className="h-4 w-4 text-emerald-400" />
                                Extension detail
                            </DialogTitle>
                            <DialogDescription className="text-xs">
                                Full metadata and lifecycle actions for the selected extension.
                            </DialogDescription>
                        </DialogHeader>

                        {!activeExtension ? (
                            <p className="text-xs text-muted-foreground">
                                No extension selected.
                            </p>
                        ) : (
                            <div className="space-y-3">
                                <div className="rounded-lg border border-border/35 bg-background/40 p-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="truncate font-mono text-sm">{activeExtension.name}</p>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {activeExtension.comment ?? "No description available."}
                                            </p>
                                        </div>
                                        {activeExtension.installed_version ? (
                                            <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                Installed
                                            </Badge>
                                        ) : (
                                            <Badge variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                Available
                                            </Badge>
                                        )}
                                    </div>
                                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                                        <p>Installed version: {activeExtensionDetail?.installed_version ?? "Not installed"}</p>
                                        <p>Default version: {activeExtensionDetail?.default_version ?? "Unknown"}</p>
                                        <p>Trusted: {activeExtensionDetail?.trusted ? "Yes" : "No"}</p>
                                        {activeExtensionDetail?.installed_owner && (
                                            <p>
                                                Owner: {activeExtensionDetail.installed_owner}
                                                {activeExtensionDetail.installed_schema
                                                    ? ` · Schema: ${activeExtensionDetail.installed_schema}`
                                                    : ""}
                                            </p>
                                        )}
                                    </div>
                                </div>

                                <div className="rounded-lg border border-border/35 bg-background/40 p-3">
                                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Target version
                                    </p>
                                    <Select
                                        value={extensionVersionSelection}
                                        onValueChange={setExtensionUpdateVersion}
                                    >
                                        <SelectTrigger className="mt-2 h-8 w-full text-xs">
                                            <SelectValue placeholder="Target version" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="__latest">Latest/default version</SelectItem>
                                            {(activeExtensionDetail?.available_versions ?? []).map((version) => (
                                                <SelectItem key={version} value={version}>
                                                    {version}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="rounded-lg border border-border/35 bg-background/40 p-3">
                                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Available versions
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {(activeExtensionDetail?.available_versions ?? []).length === 0 ? (
                                            <span className="text-xs text-muted-foreground">No version metadata</span>
                                        ) : (
                                            (activeExtensionDetail?.available_versions ?? []).map((version) => (
                                                <Badge key={version} variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                    {version}
                                                </Badge>
                                            ))
                                        )}
                                    </div>
                                    <div className="mt-2 space-y-1 text-[11px] text-amber-300">
                                        {activeExtensionDetail?.install_block_reason && (
                                            <p>Install: {activeExtensionDetail.install_block_reason}</p>
                                        )}
                                        {activeExtensionDetail?.update_block_reason && (
                                            <p>Update: {activeExtensionDetail.update_block_reason}</p>
                                        )}
                                        {activeExtensionDetail?.uninstall_block_reason && (
                                            <p>Uninstall: {activeExtensionDetail.uninstall_block_reason}</p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        <DialogFooter className="gap-2">
                            <Button
                                size="sm"
                                className="h-8 text-xs"
                                onClick={handleInstallExtension}
                                disabled={
                                    !activeExtension ||
                                    !activeExtensionDetail?.can_install ||
                                    !!activeExtension.installed_version ||
                                    !!extensionActionBusy
                                }
                            >
                                {extensionActionBusy === "install" ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    "Install"
                                )}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs"
                                onClick={handleUpdateExtension}
                                disabled={
                                    !activeExtension ||
                                    !activeExtensionDetail?.can_update ||
                                    !activeExtension.installed_version ||
                                    !!extensionActionBusy
                                }
                            >
                                {extensionActionBusy === "update" ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    "Update"
                                )}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-8 border-destructive/40 text-xs text-destructive hover:bg-destructive/10"
                                onClick={handleUninstallExtension}
                                disabled={
                                    !activeExtension ||
                                    !activeExtensionDetail?.can_uninstall ||
                                    !activeExtension.installed_version ||
                                    !!extensionActionBusy
                                }
                            >
                                {extensionActionBusy === "uninstall" ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    "Uninstall"
                                )}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                <Dialog open={isUserDetailDialogOpen} onOpenChange={setIsUserDetailDialogOpen}>
                    <DialogContent className="max-w-xl border-border/40 bg-card/95">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-sm">
                                <UserCog className="h-4 w-4 text-cyan-400" />
                                User profile detail
                            </DialogTitle>
                            <DialogDescription className="text-xs">
                                Full account and RBAC information for the selected user.
                            </DialogDescription>
                        </DialogHeader>

                        {!activeUser ? (
                            <p className="text-xs text-muted-foreground">
                                No user selected.
                            </p>
                        ) : (
                            <div className="space-y-3">
                                <div className="rounded-lg border border-border/35 bg-background/40 p-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="font-mono text-sm">{activeUser.username}</p>
                                        {activeUser.can_login ? (
                                            <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                Active
                                            </Badge>
                                        ) : (
                                            <Badge variant="outline" className="h-5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-300">
                                                Inactive
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Valid until: {activeUser.valid_until ?? "No expiry"}
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {activeUser.is_superuser && (
                                            <Badge variant="outline" className="h-5 border-cyan-500/40 bg-cyan-500/10 px-1.5 text-[10px] text-cyan-300">
                                                SUPERUSER
                                            </Badge>
                                        )}
                                        {activeUser.can_create_role && (
                                            <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                CREATEROLE
                                            </Badge>
                                        )}
                                        {activeUser.can_create_db && (
                                            <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                CREATEDB
                                            </Badge>
                                        )}
                                    </div>
                                </div>

                                <div className="rounded-lg border border-border/35 bg-background/40 p-3">
                                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Current memberships
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {activeUser.member_of.length === 0 ? (
                                            <span className="text-xs text-muted-foreground">No memberships</span>
                                        ) : (
                                            activeUser.member_of.map((roleName) => (
                                                <Badge key={roleName} variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                    {roleName}
                                                </Badge>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        <DialogFooter className="gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1.5 text-xs"
                                onClick={openMembershipManagementDialog}
                                disabled={!activeUser || !accessProfile?.is_admin || roleActionBusy !== null}
                            >
                                <UsersRound className="h-3.5 w-3.5" />
                                Manage memberships
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1.5 text-xs"
                                onClick={handleToggleUserLogin}
                                disabled={
                                    !activeUser ||
                                    userActionBusy !== null ||
                                    !accessProfile?.is_admin ||
                                    isCurrentConnectedUser
                                }
                            >
                                {activeUser?.can_login ? (
                                    <>
                                        <UserRoundX className="h-3.5 w-3.5" />
                                        Set inactive
                                    </>
                                ) : (
                                    <>
                                        <UserRound className="h-3.5 w-3.5" />
                                        Set active
                                    </>
                                )}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-8 border-destructive/40 text-xs text-destructive hover:bg-destructive/10"
                                onClick={handleDeleteUser}
                                disabled={
                                    !activeUser ||
                                    userActionBusy !== null ||
                                    !accessProfile?.is_admin ||
                                    isCurrentConnectedUser
                                }
                            >
                                Delete user
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                <Dialog
                    open={isRoleDetailDialogOpen}
                    onOpenChange={setIsRoleDetailDialogOpen}
                >
                    <DialogContent className="max-w-2xl border-border/40 bg-card/95">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-sm">
                                <BookOpenCheck className="h-4 w-4 text-cyan-400" />
                                RBAC role detail
                            </DialogTitle>
                            <DialogDescription className="text-xs">
                                Membership hierarchy and role capabilities for selected custom role.
                            </DialogDescription>
                        </DialogHeader>

                        {!activeRole ? (
                            <p className="text-xs text-muted-foreground">
                                No role selected.
                            </p>
                        ) : isLoadingRoleDetail ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Loading role detail...
                            </div>
                        ) : !activeRoleDetail ? (
                            <p className="text-xs text-muted-foreground">
                                No role detail available.
                            </p>
                        ) : (
                            <div className="space-y-3">
                                <div className="rounded-lg border border-border/35 bg-background/40 p-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="font-mono text-sm">{activeRoleDetail.name}</p>
                                        <div className="flex gap-1.5">
                                            {activeRoleDetail.is_assignable && (
                                                <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                    Assignable
                                                </Badge>
                                            )}
                                            {activeRoleDetail.inherit ? (
                                                <Badge variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                    INHERIT
                                                </Badge>
                                            ) : (
                                                <Badge variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                    NOINHERIT
                                                </Badge>
                                            )}
                                        </div>
                                    </div>
                                    {activeRoleDetail.comment && (
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {activeRoleDetail.comment}
                                        </p>
                                    )}
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {activeRoleDetail.can_create_db && (
                                            <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                CREATEDB
                                            </Badge>
                                        )}
                                        {activeRoleDetail.can_create_role && (
                                            <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                                                CREATEROLE
                                            </Badge>
                                        )}
                                        {activeRoleDetail.is_superuser && (
                                            <Badge variant="outline" className="h-5 border-cyan-500/40 bg-cyan-500/10 px-1.5 text-[10px] text-cyan-300">
                                                SUPERUSER
                                            </Badge>
                                        )}
                                    </div>
                                    {activeRoleDetail.manage_block_reason && (
                                        <p className="mt-2 text-[11px] text-amber-300">
                                            {activeRoleDetail.manage_block_reason}
                                        </p>
                                    )}
                                </div>

                                <div className="grid gap-3 sm:grid-cols-2">
                                    <div className="rounded-lg border border-border/35 bg-background/40 p-3">
                                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                            Parent roles
                                        </p>
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                            {activeRoleDetail.member_of.length === 0 ? (
                                                <span className="text-xs text-muted-foreground">No parent roles</span>
                                            ) : (
                                                activeRoleDetail.member_of.map((item) => (
                                                    <Badge key={item} variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                        {item}
                                                    </Badge>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                    <div className="rounded-lg border border-border/35 bg-background/40 p-3">
                                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                            Members
                                        </p>
                                        <ScrollArea className="mt-2 h-28">
                                            {activeRoleDetail.members.length === 0 ? (
                                                <span className="text-xs text-muted-foreground">No members</span>
                                            ) : (
                                                <div className="space-y-1">
                                                    {activeRoleDetail.members.map((member) => (
                                                        <div
                                                            key={member.name}
                                                            className="flex items-center justify-between rounded border border-border/20 px-2 py-1 text-xs"
                                                        >
                                                            <span className="font-mono">{member.name}</span>
                                                            {member.admin_option && (
                                                                <Badge variant="outline" className="h-4 border-cyan-500/40 bg-cyan-500/10 px-1 text-[9px] text-cyan-300">
                                                                    ADMIN
                                                                </Badge>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </ScrollArea>
                                    </div>
                                </div>
                            </div>
                        )}

                        <DialogFooter className="gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() => void reloadActiveRoleDetail()}
                                disabled={!activeRole}
                            >
                                <RefreshCw className={cn("h-3.5 w-3.5", isLoadingRoleDetail && "animate-spin")} />
                                Refresh detail
                            </Button>
                            {activeRole && activeUser && (
                                <>
                                    <Button
                                        size="sm"
                                        className="h-8 gap-1.5 text-xs"
                                        onClick={handleGrantActiveRoleToSelectedUser}
                                        disabled={
                                            roleActionBusy !== null ||
                                            !accessProfile?.is_admin ||
                                            selectedUserHasActiveRole
                                        }
                                    >
                                        <UserCheck className="h-3.5 w-3.5" />
                                        Grant to {activeUser.username}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8 gap-1.5 text-xs"
                                        onClick={handleRevokeActiveRoleFromSelectedUser}
                                        disabled={
                                            roleActionBusy !== null ||
                                            !accessProfile?.is_admin ||
                                            !selectedUserHasActiveRole
                                        }
                                    >
                                        <CircleSlash className="h-3.5 w-3.5" />
                                        Revoke from {activeUser.username}
                                    </Button>
                                </>
                            )}
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                <Dialog open={isCreateRoleDialogOpen} onOpenChange={setIsCreateRoleDialogOpen}>
                    <DialogContent className="max-w-lg border-border/40 bg-card/95">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-sm">
                                <Cog className="h-4 w-4 text-cyan-400" />
                                Create custom RBAC role
                            </DialogTitle>
                            <DialogDescription className="text-xs">
                                Creates a NOLOGIN role and optional parent role memberships.
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-3">
                            <div className="grid gap-2">
                                <Input
                                    value={createRoleForm.roleName}
                                    onChange={(event) =>
                                        setCreateRoleForm((current) => ({
                                            ...current,
                                            roleName: event.target.value,
                                        }))
                                    }
                                    placeholder="role name"
                                    className="h-8 text-xs"
                                />
                                <ToggleCheckbox
                                    label="Inherit grants"
                                    checked={createRoleForm.inherit}
                                    onChange={(checked) =>
                                        setCreateRoleForm((current) => ({ ...current, inherit: checked }))
                                    }
                                />
                            </div>

                            <div className="rounded border border-border/30 p-2">
                                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                    Parent memberships
                                </p>
                                <ScrollArea className="mt-2 h-32">
                                    {assignableRoles.length === 0 ? (
                                        <p className="text-xs text-muted-foreground">
                                            No assignable roles available in this admin context.
                                        </p>
                                    ) : (
                                        <div className="space-y-1">
                                            {assignableRoles
                                                .filter((role) => role.name !== createRoleForm.roleName.trim())
                                                .map((role) => (
                                                    <label
                                                        key={role.name}
                                                        className="flex cursor-pointer items-center justify-between rounded px-1 py-1 text-xs hover:bg-muted/20"
                                                    >
                                                        <span className="font-mono">{role.name}</span>
                                                        <input
                                                            type="checkbox"
                                                            checked={createRoleForm.memberships.includes(role.name)}
                                                            onChange={() => handleToggleCreateRoleMembership(role.name)}
                                                            className="h-3.5 w-3.5"
                                                        />
                                                    </label>
                                                ))}
                                        </div>
                                    )}
                                </ScrollArea>
                            </div>
                        </div>

                        <DialogFooter className="gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs"
                                onClick={() => setIsCreateRoleDialogOpen(false)}
                            >
                                Cancel
                            </Button>
                            <Button
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={handleCreateRole}
                                disabled={!accessProfile?.is_admin || roleActionBusy !== null}
                            >
                                {roleActionBusy === "create" ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <UserPlus className="h-3.5 w-3.5" />
                                )}
                                Create role
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                <Dialog
                    open={isManageMembershipDialogOpen}
                    onOpenChange={setIsManageMembershipDialogOpen}
                >
                    <DialogContent className="max-w-xl border-border/40 bg-card/95">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-sm">
                                <UsersRound className="h-4 w-4 text-cyan-400" />
                                Manage RBAC memberships
                            </DialogTitle>
                            <DialogDescription className="text-xs">
                                Grant or revoke memberships for the selected user.
                            </DialogDescription>
                        </DialogHeader>

                        {!activeUser ? (
                            <p className="text-xs text-muted-foreground">
                                No user selected.
                            </p>
                        ) : (
                            <div className="space-y-3">
                                <div className="rounded border border-border/30 bg-background/40 p-2">
                                    <p className="text-xs">
                                        Target user: <span className="font-mono">{activeUser.username}</span>
                                    </p>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                        Only roles with assignable access are editable.
                                    </p>
                                </div>

                                <div className="rounded border border-border/30 p-2">
                                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Editable memberships
                                    </p>
                                    <ScrollArea className="mt-2 h-40">
                                        {assignableRoles.length === 0 ? (
                                            <p className="text-xs text-muted-foreground">
                                                No assignable roles available.
                                            </p>
                                        ) : (
                                            <div className="space-y-1">
                                                {assignableRoles.map((role) => (
                                                    <label
                                                        key={role.name}
                                                        className="flex cursor-pointer items-center justify-between rounded px-1 py-1 text-xs hover:bg-muted/20"
                                                    >
                                                        <span className="font-mono">{role.name}</span>
                                                        <input
                                                            type="checkbox"
                                                            checked={membershipDraft.includes(role.name)}
                                                            onChange={() => handleToggleMembershipDraft(role.name)}
                                                            className="h-3.5 w-3.5"
                                                        />
                                                    </label>
                                                ))}
                                            </div>
                                        )}
                                    </ScrollArea>
                                </div>

                                <div className="rounded border border-border/30 p-2">
                                    <ToggleCheckbox
                                        label="Grant new memberships with ADMIN OPTION"
                                        checked={membershipWithAdminOption}
                                        onChange={setMembershipWithAdminOption}
                                    />
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                        This applies only to newly granted memberships in this save action.
                                    </p>
                                </div>

                                <div className="rounded border border-border/30 p-2">
                                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Read-only memberships
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {activeUser.member_of.filter((role) => !manageableRoleNames.has(role)).length === 0 ? (
                                            <span className="text-xs text-muted-foreground">No read-only memberships</span>
                                        ) : (
                                            activeUser.member_of
                                                .filter((role) => !manageableRoleNames.has(role))
                                                .map((role) => (
                                                    <Badge key={role} variant="outline" className="h-5 border-border/50 px-1.5 text-[10px]">
                                                        {role}
                                                    </Badge>
                                                ))
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        <DialogFooter className="gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs"
                                onClick={() => setIsManageMembershipDialogOpen(false)}
                            >
                                Cancel
                            </Button>
                            <Button
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={handleSaveMembershipDraft}
                                disabled={!activeUser || !accessProfile?.is_admin || roleActionBusy !== null}
                            >
                                {roleActionBusy === "membership" ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <UserCheck className="h-3.5 w-3.5" />
                                )}
                                Save memberships
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                {error && (
                    <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                        {error}
                    </div>
                )}
            </main>
        </div>
    );
}

function SummaryCard({
    title,
    value,
    icon,
}: {
    title: string;
    value: string;
    icon: ReactNode;
}) {
    return (
        <div className="rounded-xl border border-border/35 bg-card/35 px-3 py-2.5">
            <div className="flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                    {title}
                </p>
                {icon}
            </div>
            <p className="mt-2 truncate text-sm font-semibold">{value}</p>
        </div>
    );
}

function ToggleCheckbox({
    label,
    checked,
    onChange,
    disabled = false,
}: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <label
            className={cn(
                "flex items-center gap-2 rounded px-1 py-1",
                disabled ? "text-muted-foreground/50" : "hover:bg-muted/20"
            )}
        >
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked)}
                className="h-3.5 w-3.5"
            />
            <span>{label}</span>
        </label>
    );
}
