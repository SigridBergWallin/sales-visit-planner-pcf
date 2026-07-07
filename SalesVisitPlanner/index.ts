/*
 * SalesVisitPlanner PCF Control
 * ─────────────────────────────
 * Split-panel field control: visit list (left) + Azure Maps (right).
 * Fetches appointments linked to the current Sales Visit Plan via
 * context.webAPI, geocodes locations with Azure Maps Search API,
 * and renders numbered pins + route line.
 */

import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { searchNearbyBusinesses, searchByBuyerType, ProspectResult as ExternalProspectResult } from "./ProspectSearch";

/* ── Appointment model ── */
interface VisitItem {
    id: string;
    subject: string;
    scheduledStart: Date;
    scheduledEnd: Date | null;
    location: string;
    accountName: string | null;
    accountId: string | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
    geocodeError: boolean;
    driveSec: number | null;
    driveMeters: number | null;
    eta: string | null;
    opportunityId: string | null;
    opportunityName: string | null;
    isPriority: boolean;
    invitationStatus: number;
    accountCity: string | null;
    estimatedValue: number | null;
    salesStage: string | null;
    estimatedCloseDate: string | null;
    ownerName: string | null;
    regardingType: string | null;
    actualstart: Date | null;
    statecode?: number;
    actualend?: Date | null;
}

interface TimelineItem {
    type: "visit" | "drive" | "gap" | "boundary";
    visit?: VisitItem;
    visitIndex?: number;
    driveSeconds?: number;
    driveMeters?: number;
    gapStart?: Date;
    gapEnd?: Date;
    gapMinutes?: number;
    previousCity?: string | null;
    boundaryLabel?: string;
    boundaryMins?: number;
}

interface LegSummary {
    travelTimeSeconds: number;
    lengthInMeters: number;
}

/* ── Prospect finder models ── */
interface ProspectResult {
    type: "account" | "lead" | "external";
    id: string;
    name: string;
    address: string;
    city: string;
    lat: number | null;
    lon: number | null;
    distanceKm: number | null;
    hasOpenOpportunity: boolean;
    lastVisitDays: number | null;      // null = never visited
    leadId?: string;                    // set after "Create lead"
    isBuyerMatch?: boolean;             // set in buyer-type search mode
    // Azure Maps POI fields (external only)
    poiAddress?: { streetNameAndNumber?: string; municipality?: string; postalCode?: string; country?: string };
    poiName?: string;
}

type ProspectFilter = "all" | "in-d365" | "not-in-d365" | "no-recent-visit";
type ProspectSearchMode = "name" | "buyer";

/* ── Territory insights models ── */
interface TerritoryAccount {
    accountId: string;
    name: string;
    address: string | null;
    city: string | null;
    lat: number | null;
    lon: number | null;
    phone: string | null;
    lastVisitDate: Date | null;
    daysSinceVisit: number | null;   // null = never visited
    openOpportunities: number;
    totalPipelineValue: number;
    topOpportunity: string | null;
    visitCategory: "overdue" | "due-soon" | "recent" | "never"; // color coding
}

type TerritorySort = "name" | "lastVisit" | "pipeline" | "opportunities";
type TerritoryFilter = "all" | "overdue" | "due-soon" | "recent" | "never";

/* ── Address resolution helpers ── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAccountAddress(appointment: any): {
    accountName: string | null;
    address: string | null;
    accountId: string | null;
    accountCity: string | null;
} {
    const apptId = appointment.activityid ?? "(unknown)";
    const parties = appointment.appointment_activity_parties || [];

    // Strategy 1: directly linked Account party
    for (const party of parties) {
        const account = party.partyid_account;
        if (account) {
            const addr = buildAddressString(account);
            console.log(`[SVP] getAccountAddress [${apptId}] Strategy1-DirectAccount: name=${account.name}, addr=${addr}, id=${account.accountid}`);
            return { accountName: account.name, address: addr, accountId: account.accountid ?? null, accountCity: account.address1_city ?? null };
        }
    }

    // Strategy 2: Contact party's parent Account
    for (const party of parties) {
        const contact = party.partyid_contact;
        if (contact?.parentcustomerid_account) {
            const acc = contact.parentcustomerid_account;
            const addr = buildAddressString(acc);
            console.log(`[SVP] getAccountAddress [${apptId}] Strategy2-ContactParentAccount: name=${acc.name}, addr=${addr}, id=${acc.accountid}`);
            return { accountName: acc.name, address: addr, accountId: acc.accountid ?? null, accountCity: acc.address1_city ?? null };
        }
    }

    // Strategy 3: Opportunity's parent Account (regardingobjectid_opportunity)
    const opp = appointment.regardingobjectid_opportunity;
    if (opp?.parentaccountid) {
        const acc = opp.parentaccountid;
        const addr = buildAddressString(acc);
        console.log(`[SVP] getAccountAddress [${apptId}] Strategy3-OppParentAccount: name=${acc.name}, addr=${addr}, id=${acc.accountid}`);
        return { accountName: acc.name, address: addr, accountId: acc.accountid ?? null, accountCity: acc.address1_city ?? null };
    }

    // No account found — fall back to appointment Location field
    console.log(`[SVP] getAccountAddress [${apptId}] AllStrategiesFailed: parties=${parties.length}, opp=${JSON.stringify(opp)}, location=${appointment.location}`);
    return { accountName: null, address: appointment.location || null, accountId: null, accountCity: null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAccountId(appointment: any): string | null {
    const parties = appointment.appointment_activity_parties || [];

    // Try directly linked Account first
    for (const party of parties) {
        if (party.partyid_account?.accountid) {
            return party.partyid_account.accountid;
        }
    }

    // Fall back to Contact's parent Account
    for (const party of parties) {
        const parentAccount = party.partyid_contact?.parentcustomerid_account;
        if (parentAccount?.accountid) {
            return parentAccount.accountid;
        }
    }

    return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildAddressString(account: any): string | null {
    const parts = [
        account.address1_line1,
        account.address1_city,
        account.address1_stateorprovince,
        account.address1_postalcode,
        account.address1_country,
    ].filter((p: string) => p && p.trim() !== "");

    return parts.length > 0 ? parts.join(", ") : null;
}

/* ── Geolocation helper ── */

function getCurrentPosition(): Promise<[number, number]> {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("Geolocation not supported"));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve([pos.coords.longitude, pos.coords.latitude]),
            (err) => reject(err),
            { timeout: 10000, maximumAge: 60000 }
        );
    });
}

/* ── Route API helper (tries v2025-01-01 POST, falls back to v1.0 GET) ── */

async function getDrivingRoute(
    waypoints: [number, number][],
    azureMapsKey: string
): Promise<{
    routePoints: [number, number][];
    legSummaries: LegSummary[];
} | null> {
    if (waypoints.length < 2) {
        console.warn("Not enough waypoints:", waypoints.length);
        return null;
    }

    // Try the new POST API first, fall back to the classic GET API
    try {
        const result = await getDrivingRoutePost(waypoints, azureMapsKey);
        if (result) return result;
    } catch (err) {
        console.warn("[Route] POST API failed, falling back to GET v1.0:", err);
    }

    return getDrivingRouteGet(waypoints, azureMapsKey);
}

/* ── POST-based v2025-01-01 ── */

async function getDrivingRoutePost(
    waypoints: [number, number][],
    azureMapsKey: string
): Promise<{
    routePoints: [number, number][];
    legSummaries: LegSummary[];
} | null> {
    const features = waypoints.map((coord, index) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: coord },
        properties: { pointIndex: index, pointType: "waypoint" },
    }));

    const requestBody = {
        type: "FeatureCollection" as const,
        features,
        travelMode: "driving",
        routeOutputOptions: ["routePath", "summary", "legs"],
        optimizeRoute: "shortest",
    };

    const url =
        `https://atlas.microsoft.com/route/directions` +
        `?api-version=2025-01-01` +
        `&subscription-key=${azureMapsKey}`;

    console.log("[Route POST] URL:", url);
    console.log("[Route POST] body:", JSON.stringify(requestBody));

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
    });

    console.log("[Route POST] status:", response.status);

    if (!response.ok) {
        const errorBody = await response.text();
        console.error("[Route POST] error:", errorBody);
        throw new Error(`POST Route API failed: ${response.status}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    console.log("[Route POST] response keys:", Object.keys(data));

    const routeFeature = data.features?.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (f: any) => f.geometry?.type === "MultiLineString"
    );

    if (!routeFeature) {
        console.error("[Route POST] No MultiLineString:", JSON.stringify(data).substring(0, 500));
        throw new Error("No route geometry returned from POST API");
    }

    const routePoints: [number, number][] = routeFeature.geometry.coordinates.flat();
    console.log(`[Route POST] ${routePoints.length} geometry points`);

    const waypointFeatures = data.features?.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (f: any) => f.properties?.type === "Waypoint"
    ) ?? [];

    const legSummaries: LegSummary[] = waypointFeatures
        .slice(0, -1)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((f: any) => ({
            travelTimeSeconds: f.properties?.durationInSeconds ?? 0,
            lengthInMeters: f.properties?.distanceInMeters ?? 0,
        }));

    if (legSummaries.length === 0) {
        const summaryFeature = data.features?.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (f: any) => f.properties?.resourceId
        );
        const totalSeconds = summaryFeature?.properties?.durationInSeconds ?? 0;
        const totalMeters = summaryFeature?.properties?.distanceInMeters ?? 0;
        const perLeg = waypoints.length - 1;
        for (let i = 0; i < perLeg; i++) {
            legSummaries.push({
                travelTimeSeconds: Math.round(totalSeconds / perLeg),
                lengthInMeters: Math.round(totalMeters / perLeg),
            });
        }
    }

    return { routePoints, legSummaries };
}

/* ── GET-based v1.0 (classic fallback) ── */

async function getDrivingRouteGet(
    waypoints: [number, number][],
    azureMapsKey: string
): Promise<{
    routePoints: [number, number][];
    legSummaries: LegSummary[];
} | null> {
    const waypointStr = waypoints
        .map(([lon, lat]) => `${lat},${lon}`)
        .join(":");

    const url =
        `https://atlas.microsoft.com/route/directions/json` +
        `?api-version=1.0` +
        `&subscription-key=${azureMapsKey}` +
        `&query=${waypointStr}` +
        `&travelMode=car` +
        `&routeType=fastest`;

    console.log("[Route GET] URL:", url);

    const response = await fetch(url);
    console.log("[Route GET] status:", response.status);

    if (!response.ok) {
        const errorBody = await response.text();
        console.error("[Route GET] error:", errorBody);
        throw new Error(`GET Route API failed: ${response.status}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (!data.routes || data.routes.length === 0) {
        console.error("[Route GET] No routes:", JSON.stringify(data).substring(0, 500));
        throw new Error("No routes returned from GET API");
    }

    const route = data.routes[0];
    console.log("[Route GET] legs:", route.legs?.length, "summary:", JSON.stringify(route.summary));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routePoints: [number, number][] = route.legs.flatMap((leg: any) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        leg.points.map((p: any) => [p.longitude, p.latitude] as [number, number])
    );

    console.log(`[Route GET] ${routePoints.length} geometry points`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legSummaries: LegSummary[] = route.legs.map((leg: any) => ({
        travelTimeSeconds: leg.summary.travelTimeInSeconds,
        lengthInMeters: leg.summary.lengthInMeters,
    }));

    return { routePoints, legSummaries };
}

/* ── Straight-line distance fallback ── */

function estimateTravelTime(from: [number, number], to: [number, number]): number {
    // Haversine distance in km, assume 60 km/h average speed
    const R = 6371;
    const dLat = ((to[1] - from[1]) * Math.PI) / 180;
    const dLon = ((to[0] - from[0]) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((from[1] * Math.PI) / 180) *
        Math.cos((to[1] * Math.PI) / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round((distanceKm / 60) * 3600); // seconds at 60 km/h
}

function haversineDistance(from: [number, number], to: [number, number]): number {
    const R = 6371;
    const dLat = ((to[1] - from[1]) * Math.PI) / 180;
    const dLon = ((to[0] - from[0]) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((from[1] * Math.PI) / 180) *
        Math.cos((to[1] * Math.PI) / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1000; // meters
}

/* ── Formatting helpers ── */

function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function formatDistance(meters: number): string {
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
    return `${meters} m`;
}

function addMinutesToTime(baseTime: Date, seconds: number): string {
    const arrival = new Date(baseTime.getTime() + seconds * 1000);
    return arrival.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
    });
}

/* ── Status option-set values ── */

// Option-set values for the appointment invitation-status choice column and
// the visit-plan status choice column. These match the values provisioned by
// the companion reference solution. Centralised here so a reuse org can align
// its own choice-column values in one place instead of hunting magic numbers.
const STATUS = {
    invitation: {
        notSent: 100000000,
        invited: 100000001,
        accepted: 100000002,
        declined: 100000003,
    },
    plan: {
        active: 100000001,
        completed: 100000002,
    },
} as const;

/* ── Visit order / invitation status helpers ── */

// The optional primaryField is the configured schema name (from the manifest);
// the remaining names are legacy fallbacks kept for backward compatibility.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getVisitOrder(appt: any, primaryField?: string): number {
    return (primaryField ? appt[primaryField] : undefined)
        ?? appt.vis_new_visitorder ?? appt.vis_visitorder ?? appt.new_visitorder ?? 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getInvitationStatus(appt: any, primaryField?: string): number {
    return (primaryField ? appt[primaryField] : undefined)
        ?? appt.vis_new_invitationstatus ?? appt.vis_invitationstatus ?? appt.new_invitationstatus ?? STATUS.invitation.notSent;
}

export class SalesVisitPlanner implements ComponentFramework.StandardControl<IInputs, IOutputs> {

    private _container!: HTMLDivElement;
    private _listBody!: HTMLDivElement;
    private _summaryEl!: HTMLDivElement;
    private _mapEl!: HTMLDivElement;
    private _mapBanner!: HTMLDivElement;
    private _map: atlas.Map | null = null;
    private _azureMapsKey = "";
    private _visits: VisitItem[] = [];
    private _loaded = false;
    private _isHarness = false;
    private _currentPosition: [number, number] | null = null;
    private _routePoints: [number, number][] = [];
    private _legSummaries: LegSummary[] = [];
    private _pollingInterval: number | null = null;
    private _lastKnownActivityIds = new Set<string>();
    private _context: ComponentFramework.Context<IInputs> | null = null;
    private _planId = "";
    /** The Visit Date & Start Time stored on the Sales Visit Plan record.
     *  Used as the source-of-truth for the header date label. */
    private _planDate: Date | null = null;
    private _isOptimizing = false;

    /* Active mode for header button highlighting */
    private _activeMode: "plan" | "optimize" | "invitations" | "findProspects" | "territory" = "plan";
    private _optimizeBtn: HTMLButtonElement | null = null;
    private _invitationsBtn: HTMLButtonElement | null = null;
    private _prospectBtn: HTMLButtonElement | null = null;
    private _territoryBtn: HTMLButtonElement | null = null;
    private _preOptimizationOrder: VisitItem[] = [];
    private _knownPriorityIds = new Set<string>();
    private _optimizedLegSummaries: { travelTimeSeconds: number; travelTimeFormatted: string }[] = [];
    private _resizeObserver: ResizeObserver | null = null;
    private _currentLayout: "narrow" | "wide" = "narrow";
    private _onWindowResize: (() => void) | null = null;

    /* Prospect finder state */
    private _prospectResults: ProspectResult[] = [];
    private _prospectFilter: ProspectFilter = "all";
    private _prospectRadiusKm = 10;
    private _prospectLastQuery = "";
    private _prospectMarkers: atlas.HtmlMarker[] = [];
    // Map of visit-id → numbered HtmlMarker so we can re-style on Check Out
    private _visitMarkers = new Map<string, atlas.HtmlMarker>();
    // Route source kept on instance so we can recolor segments after Check Out
    private _routeSource: atlas.source.DataSource | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _prospectDataSource: any = null;
    private _prospectLayerIds: string[] = [];
    private _prospectPanelOpen = false;
    private _prospectCity = "";
    private _prospectCityLat: number | null = null;
    private _prospectCityLon: number | null = null;
    private _prospectCitySelected = false;
    private _prospectSearchMode: ProspectSearchMode = "name";
    private _prospectPopup: atlas.Popup | null = null;
    private _prospectSearchOverlay: HTMLDivElement | null = null;
    private _prospectCityCloseHandler: ((e: MouseEvent) => void) | null = null;

    /* Territory insights state */
    private _viewMode: "visitPlan" | "territoryInsights" = "visitPlan";
    private _territoryAccounts: TerritoryAccount[] = [];
    private _territoryDataSource: atlas.source.DataSource | null = null;
    private _territoryLayerIds: string[] = [];
    private _territoryFilter: TerritoryFilter = "all";
    private _territorySort: TerritorySort = "lastVisit";
    private _territorySelectedIds = new Set<string>();
    private _lastVisitField = "vis_lastvisitdate";
    private _workDayStartField = "vis_starttime";
    private _workDayEndField = "vis_workdayend";
    private _planTable = "vis_salesvisitplan";
    private _planCollection = "vis_salesvisitplans";
    private _planStatusField = "vis_status";
    private _driveMinutesField = "vis_new_totaldriveminutes";
    private _isPriorityField = "vis_new_ispriority";
    private _visitOrderField = "vis_new_visitorder";
    private _invitationStatusField = "vis_new_invitationstatus";
    private _planLookupNav = "vis_new_salesvisitplanid_Appointment";
    private _planLookupField = "vis_new_salesvisitplanid";
    private _geocodeCountrySet = "DK,SE,NO,DE,NL,BE,FR,GB";
    private _workStartMins = 480; // 8:00 default
    private _workEndMins = 1020;  // 17:00 default
    private _territoryPopup: atlas.Popup | null = null;
    private _territoryScope: "my" | "global" = "my";
    private _territorySearchTerm = "";
    private _territoryCityFilter = "All cities";
    private _territorySearchDebounce: number | null = null;
    private _territoryGlobalAccounts: TerritoryAccount[] | null = null; // cached global dataset
    private _territoryCapped = false;

    /* ───────────────── LIFECYCLE ───────────────── */

    public init(
        context: ComponentFramework.Context<IInputs>,
        _notifyOutputChanged: () => void,
        _state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this._container = container;
        this._context = context;
        this._azureMapsKey = context.parameters.azureMapsKey.raw ?? "";
        this._lastVisitField = context.parameters.lastVisitField?.raw ?? "vis_lastvisitdate";
        this._workDayStartField = context.parameters.workDayStartField?.raw?.trim() || "vis_starttime";
        this._workDayEndField = context.parameters.workDayEndField?.raw?.trim() || "vis_workdayend";
        this._planTable = context.parameters.planTable?.raw?.trim() || "vis_salesvisitplan";
        this._planCollection = context.parameters.planCollection?.raw?.trim() || "vis_salesvisitplans";
        this._planStatusField = context.parameters.planStatusField?.raw?.trim() || "vis_status";
        this._driveMinutesField = context.parameters.driveMinutesField?.raw?.trim() || "vis_new_totaldriveminutes";
        this._isPriorityField = context.parameters.isPriorityField?.raw?.trim() || "vis_new_ispriority";
        this._visitOrderField = context.parameters.visitOrderField?.raw?.trim() || "vis_new_visitorder";
        this._invitationStatusField = context.parameters.invitationStatusField?.raw?.trim() || "vis_new_invitationstatus";
        this._planLookupNav = context.parameters.planLookupNav?.raw?.trim() || "vis_new_salesvisitplanid_Appointment";
        this._planLookupField = context.parameters.planLookupField?.raw?.trim() || "vis_new_salesvisitplanid";
        this._geocodeCountrySet = context.parameters.geocodeCountrySet?.raw?.trim() || "DK,SE,NO,DE,NL,BE,FR,GB";
        this._isHarness = this._detectHarness();

        // Tell D365 to notify us of container resize / allocated height
        context.mode.trackContainerResize(true);

        // Pin container height to available viewport space
        this._pinContainerHeight();
        this._onWindowResize = () => this._pinContainerHeight();
        window.addEventListener("resize", this._onWindowResize);

        this._buildShell();

        if (this._isHarness) {
            // Running in PCF test harness — use mock data, no API calls needed
            this._loadMockData();
            this._renderList();
            this._renderJourneySummary();
            this._renderMockMap();
            return;
        }

        if (!this._azureMapsKey) {
            this._mapEl.innerHTML =
                `<div class="svp-error">Azure Maps key is not configured. Set the azureMapsKey property on this control.</div>`;
            this._fetchAndRenderListOnly(context);
            return;
        }

        this._injectAzureMaps()
            .then(() => this._fetchAndRender(context))
            .catch((err) => {
                this._listBody.innerHTML = `<div class="svp-error">Failed to load Azure Maps SDK: ${String(err)}</div>`;
            });
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        // Re-pin height when D365 notifies of a resize
        this._pinContainerHeight();
    }

    public getOutputs(): IOutputs {
        return {};
    }

    public destroy(): void {
        if (this._onWindowResize) {
            window.removeEventListener("resize", this._onWindowResize);
            this._onWindowResize = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._pollingInterval !== null) {
            window.clearInterval(this._pollingInterval);
            this._pollingInterval = null;
        }
        if (this._map) {
            this._map.dispose();
            this._map = null;
        }
    }

    /* ───────────────── HEIGHT CALCULATION ───────────────── */

    private _pinContainerHeight(): void {
        const topOffset = this._container.getBoundingClientRect().top;
        const available = window.innerHeight - topOffset - 24;
        const h = Math.max(available, 400);
        this._container.style.height = `${h}px`;
        this._container.style.overflow = "hidden";
    }

    /**
     * Renders the header title using the plan's own Visit Date (vis_starttime)
     * when available. Falls back to a neutral "Plan" label so we never
     * mislead the rep about which day they're looking at.
     */
    private _updateHeaderTitle(): void {
        const titleEl = this._container.querySelector(".svp-header-title") as HTMLDivElement | null;
        if (!titleEl) return;
        const d = this._planDate;
        if (d && !Number.isNaN(d.getTime())) {
            const dayName = d.toLocaleDateString("en-GB", { weekday: "long" });
            const dateStr = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
            titleEl.textContent = `Plan \u2014 ${dayName} ${dateStr}`;
        } else {
            titleEl.textContent = "Plan";
        }
    }

    /* ───────────────── DOM SHELL ───────────────── */

    private _buildShell(): void {
        // The header date is filled in once the plan record is loaded
        // (see _updateHeaderTitle). We start with a placeholder so the shell
        // can render before the webAPI roundtrip completes.
        const dayName = "";
        const dateStr = "";

        // Phone layout detection. The most reliable signal that works across
        // hosts (D365 Sales mobile app, Power Apps Mobile, mobile browser) is
        // the user-agent string — desktop browsers never match these tokens.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client: any = this._context?.client;
        let formFactor: number | null = null;
        let clientName: string | null = null;
        try {
            formFactor = typeof client?.getFormFactor === "function" ? client.getFormFactor() : null;
            clientName = typeof client?.getClient === "function" ? client.getClient() : null;
        } catch { /* noop */ }
        const ua = navigator.userAgent || "";
        const isMobileUA = /iPhone|iPod|Android.*Mobile|IEMobile|Windows Phone|BlackBerry|webOS/i.test(ua);
        const isPhoneMobile = isMobileUA;
        console.log("[SVP] Layout detection:", {
            formFactor, clientName,
            ua, isMobileUA,
            viewportW: window.innerWidth,
            isPhoneMobile,
        });
        if (isPhoneMobile) {
            this._container.classList.add("svp--phone-mobile");
            this._container.setAttribute("data-active-tab", "list");
        }

        this._container.innerHTML = `
            <div class="svp-root">
                <div class="svp-mobile-tabs" role="tablist">
                    <button class="svp-mobile-tab is-active" data-tab="list" role="tab" aria-selected="true">List</button>
                    <button class="svp-mobile-tab" data-tab="map" role="tab" aria-selected="false">Map</button>
                </div>
                <div class="svp-list-panel">
                    <div class="svp-list-header">
                        <div class="svp-header-title">Plan${dayName ? ` \u2014 ${dayName} ${dateStr}` : ""}</div>
                        <div class="svp-journey-summary"></div>
                        <div class="svp-working-hours-row"></div>
                        <div class="svp-header-actions svp-header-loading">
                            <button class="svp-optimize-btn" id="svp-optimize-btn">Optimize</button>
                            <button class="send-invitations-btn" id="sendInvitationsBtn">Invitations</button>
                            <button class="svp-prospect-btn" id="svp-prospect-btn">Find prospects</button>
                            <button class="svp-territory-btn" id="svp-territory-btn">Territory insights</button>
                        </div>
                    </div>
                    <div class="svp-list-body">
                        <div class="svp-loading">Loading appointments…</div>
                    </div>
                </div>
                <div class="svp-map-panel">
                    <div class="svp-map-banner"></div>
                    <div class="svp-map" id="svp-map"></div>
                </div>
            </div>`;
        this._listBody = this._container.querySelector(".svp-list-body") as HTMLDivElement;
        this._summaryEl = this._container.querySelector(".svp-journey-summary") as HTMLDivElement;
        this._mapEl = this._container.querySelector(".svp-map") as HTMLDivElement;
        this._mapBanner = this._container.querySelector(".svp-map-banner") as HTMLDivElement;

        // Store direct references to header buttons (single source of truth)
        this._optimizeBtn = this._container.querySelector("#svp-optimize-btn") as HTMLButtonElement;
        this._invitationsBtn = this._container.querySelector("#sendInvitationsBtn") as HTMLButtonElement;
        this._prospectBtn = this._container.querySelector("#svp-prospect-btn") as HTMLButtonElement;
        this._territoryBtn = this._container.querySelector("#svp-territory-btn") as HTMLButtonElement;

        // Mobile tab switching (only meaningful when .svp--phone-mobile is set).
        // Switching to Map triggers a resize() so Azure Maps redraws at the new size.
        const tabBtns = this._container.querySelectorAll<HTMLButtonElement>(".svp-mobile-tab");
        tabBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                const tab = btn.getAttribute("data-tab") ?? "list";
                this._container.setAttribute("data-active-tab", tab);
                tabBtns.forEach((b) => {
                    const active = b.getAttribute("data-tab") === tab;
                    b.classList.toggle("is-active", active);
                    b.setAttribute("aria-selected", active ? "true" : "false");
                });
                if (tab === "map") {
                    // Map was display:none — fire two resize() pulses so the canvas
                    // picks up the new container size reliably on slow devices.
                    const resizeMap = (): void => {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            (this._map as any)?.resize?.();
                        } catch { /* noop */ }
                    };
                    requestAnimationFrame(resizeMap);
                    setTimeout(resizeMap, 250);
                }
            });
        });

        // Responsive layout via ResizeObserver
        const root = this._container.querySelector(".svp-root") as HTMLDivElement;
        if (root) {
            this._resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    const w = entry.contentRect.width;
                    // On phone-mobile we drive layout via the tab strip, not width.
                    // Force layout-narrow so the map pane stays under our tab control.
                    const layout: "narrow" | "wide" =
                        this._container.classList.contains("svp--phone-mobile")
                            ? "narrow"
                            : (w >= 520 ? "wide" : "narrow");
                    if (layout !== this._currentLayout) {
                        root.classList.remove("layout-narrow", "layout-wide");
                        root.classList.add(`layout-${layout}`);
                        this._currentLayout = layout;
                    }
                }
                // Trigger map resize so it redraws within new bounds
                if (this._map) {
                    const mapRef = this._map;
                    requestAnimationFrame(() => mapRef.resize());
                }
            });
            this._resizeObserver.observe(root);
            // Set initial class
            root.classList.add("layout-narrow");
        }
    }

    /* ───────────────── AZURE MAPS CDN INJECT ───────────────── */

    private _injectAzureMaps(): Promise<void> {
        // If already loaded globally, skip.
        if (typeof atlas !== "undefined" && atlas.Map) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            // CSS
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = "https://atlas.microsoft.com/sdk/javascript/mapcontrol/3/atlas.min.css";
            document.head.appendChild(link);

            // JS
            const script = document.createElement("script");
            script.src = "https://atlas.microsoft.com/sdk/javascript/mapcontrol/3/atlas.min.js";
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("Failed to load Azure Maps SDK"));
            document.head.appendChild(script);
        });
    }

    /* ───────────────── DATA FETCH (list-only, no map key) ───────────────── */

    private async _fetchAndRenderListOnly(context: ComponentFramework.Context<IInputs>): Promise<void> {
        try {
            await this._fetchAppointments(context);
            this._renderList();
            this._container.querySelector(".svp-header-actions")?.classList.remove("svp-header-loading");
        } catch (err) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (err as any)?.message ?? (err as any)?.errorCode ?? JSON.stringify(err) ?? "Unknown error";
            console.error("[SVP] Appointment fetch error:", err);
            this._listBody.innerHTML = `<div class="svp-error">Error loading appointments: ${this._escapeHtml(String(msg))}</div>`;
        }
    }

    /* ───────────────── DATA FETCH (full) ───────────────── */

    private async _fetchAndRender(context: ComponentFramework.Context<IInputs>): Promise<void> {
        try {
            // 1. Fetch appointments
            await this._fetchAppointments(context);

            // 1b. Fetch working hours from plan record
            await this._fetchWorkingHours(context);

            // 2. Try to get sales rep location
            try {
                this._currentPosition = await getCurrentPosition();
            } catch {
                this._currentPosition = null;
                this._showMapBanner(
                    "\u26A0\uFE0F Could not get your current location. Route will start from the first appointment instead.",
                    "warning"
                );
            }

            // 3. Geocode all visits
            await this._geocodeAll();

            // 4. Fetch opportunities for all visits in parallel
            await this._fetchOpportunities();

            // 5. Build waypoints and call route API
            await this._calculateRoute();

            // 6. Render
            this._renderList();
            this._renderJourneySummary();
            this._renderWorkingHoursRow();
            this._renderMap();
            this._wireOptimizeButton();
            this._wireSendInvitationsButton();
            this._wireProspectButton();
            this._wireTerritoryButton();
            this._container.querySelector(".svp-header-actions")?.classList.remove("svp-header-loading");
            this._updateHeaderButtonStyles();

            // Populate known priority IDs so we only notify for NEW flags
            this._knownPriorityIds = new Set(
                this._visits
                    .filter((v) => v.isPriority)
                    .map((v) => v.id)
            );

            this._loaded = true;
            this._startPolling();
        } catch (err) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (err as any)?.message ?? (err as any)?.errorCode ?? JSON.stringify(err) ?? "Unknown error";
            console.error("[SVP] Appointment fetch error:", err);
            this._listBody.innerHTML = `<div class="svp-error">Error loading appointments: ${this._escapeHtml(String(msg))}</div>`;
        }
    }

    /** Check whether coordinates are plausible for Northern Europe */
    private static _isValidNorthernEuropeCoord(lat: number | null, lon: number | null): boolean {
        return lat != null && lon != null &&
            !isNaN(lat) && !isNaN(lon) &&
            lat !== 0 && lon !== 0 &&
            lat > 47 && lat < 72 &&   // Northern Europe latitude range
            lon > -12 && lon < 32;    // Northern Europe longitude range (includes UK/Ireland)
    }

    private async _calculateRoute(): Promise<void> {
        const geocoded = this._visits.filter((v) => {
            if (v.lat === null || v.lng === null) return false;
            if (!SalesVisitPlanner._isValidNorthernEuropeCoord(v.lat, v.lng)) {
                console.warn(`[SVP] Route: skipping visit with out-of-range coords: ${v.accountName ?? v.subject}`, { lat: v.lat, lng: v.lng });
                return false;
            }
            return true;
        });

        if (geocoded.length === 0) {
            return;
        }

        // Build waypoints: start from GPS or first appointment
        // When no GPS, avoid duplicating the first appointment as both start and first stop
        const hasGps = this._currentPosition !== null;
        const startPos: [number, number] = this._currentPosition
            ?? [geocoded[0].lng!, geocoded[0].lat!];

        // Validate GPS start position too
        if (hasGps && !SalesVisitPlanner._isValidNorthernEuropeCoord(startPos[1], startPos[0])) {
            console.warn("[SVP] Route: GPS position outside Northern Europe, using first visit instead", startPos);
        }

        const stops = hasGps
            ? geocoded.map((v) => [v.lng!, v.lat!] as [number, number])
            : geocoded.slice(1).map((v) => [v.lng!, v.lat!] as [number, number]);

        const waypoints: [number, number][] = [startPos, ...stops];

        if (waypoints.length < 2) {
            return;
        }

        try {
            const result = await getDrivingRoute(waypoints, this._azureMapsKey);

            if (result) {
                this._routePoints = result.routePoints;
                this._legSummaries = result.legSummaries;

                // Assign timing to each geocoded visit
                // With GPS: leg[0]=GPS→visit[0], leg[1]=visit[0]→visit[1], etc.
                // Without GPS: leg[0]=visit[0]→visit[1], so visit[0] has no incoming leg
                let cumulativeSec = 0;
                let departureTime: Date = new Date();

                geocoded.forEach((visit, idx) => {
                    // When no GPS, first visit is the start — it has no incoming leg
                    const legIdx = hasGps ? idx : idx - 1;
                    if (legIdx >= 0 && legIdx < result.legSummaries.length) {
                        const leg = result.legSummaries[legIdx];
                        visit.driveSec = leg.travelTimeSeconds;
                        visit.driveMeters = leg.lengthInMeters;

                        if (idx === 0 && hasGps) {
                            departureTime = new Date();
                        } else if (idx === 0) {
                            departureTime = visit.scheduledStart;
                        }

                        cumulativeSec += leg.travelTimeSeconds;
                        visit.eta = addMinutesToTime(departureTime, cumulativeSec);

                        if (visit.scheduledEnd) {
                            departureTime = visit.scheduledEnd;
                            cumulativeSec = 0;
                        }
                    }
                });
            } else {
                // getDrivingRoute returned null (not enough waypoints)
                this._applyFallbackEstimates(waypoints, geocoded);
            }
        } catch (err) {
            console.error("Full routing error:", err);
            this._showMapBanner(
                "\u26A0\uFE0F Live routing unavailable \u2014 showing straight-line route instead. Travel times are estimates based on straight-line distance.",
                "warning"
            );
            // Fall back to straight-line estimates
            this._applyFallbackEstimates(waypoints, geocoded);
        }
    }

    private _applyFallbackEstimates(waypoints: [number, number][], geocoded: VisitItem[]): void {
        const fallbackLegs: LegSummary[] = [];
        let departureTime: Date = new Date();
        let cumulativeSec = 0;

        for (let i = 0; i < geocoded.length; i++) {
            const from = i === 0 ? waypoints[0] : [geocoded[i - 1].lng!, geocoded[i - 1].lat!] as [number, number];
            const to: [number, number] = [geocoded[i].lng!, geocoded[i].lat!];
            const sec = estimateTravelTime(from, to);
            const meters = Math.round(haversineDistance(from, to));

            fallbackLegs.push({ travelTimeSeconds: sec, lengthInMeters: meters });
            geocoded[i].driveSec = sec;
            geocoded[i].driveMeters = meters;

            if (i === 0 && this._currentPosition) {
                departureTime = new Date();
            } else if (i === 0) {
                departureTime = geocoded[i].scheduledStart;
            }

            cumulativeSec += sec;
            geocoded[i].eta = addMinutesToTime(departureTime, cumulativeSec);

            if (geocoded[i].scheduledEnd) {
                departureTime = geocoded[i].scheduledEnd!;
                cumulativeSec = 0;
            }
        }

        this._legSummaries = fallbackLegs;
    }

    private _showMapBanner(message: string, level: "warning" | "error" | "info"): void {
        const cls = level === "error" ? "svp-banner-error"
            : level === "warning" ? "svp-banner-warning"
                : "svp-banner-info";
        this._mapBanner.innerHTML = `<div class="svp-banner ${cls}">${message}
            <button class="svp-banner-close" onclick="this.parentElement.remove()">&times;</button></div>`;
    }

    private async _fetchAppointments(context: ComponentFramework.Context<IInputs>): Promise<void> {
        // Get the plan ID from the bound property or from the form context
        const planId =
            context.parameters.recordId?.raw ??
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (context.mode as any).contextInfo?.entityId ??
            "";

        if (!planId) {
            this._showEmptyState(
                "\u26A0\uFE0F No Sales Visit Plan ID found. " +
                "Please bind the Record ID property to this control on the form."
            );
            return;
        }

        this._planId = planId;
        console.log("Loading appointments for plan:", planId);

        // Fetch the plan record itself so we can show the plan's Visit Date
        // (vis_starttime) in the header instead of "today".
        try {
            const plan = await context.webAPI.retrieveRecord(
                this._planTable,
                planId,
                `?$select=${this._workDayStartField}`
            );
            const raw = plan[this._workDayStartField];
            this._planDate = raw ? new Date(raw) : null;
        } catch (err) {
            console.warn(`[SVP] Could not load plan ${this._workDayStartField} for header:`, err);
            this._planDate = null;
        }
        this._updateHeaderTitle();

        const options =
            `?$select=subject,scheduledstart,scheduledend,location,statecode,statuscode,activityid,actualstart,actualend,` +
            `${this._isPriorityField},${this._visitOrderField},${this._invitationStatusField},_regardingobjectid_value` +
            `&$expand=appointment_activity_parties(` +
            `$select=participationtypemask;` +
            `$expand=partyid_account(` +
            `$select=name,accountid,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country` +
            `),partyid_contact(` +
            `$select=fullname;` +
            `$expand=parentcustomerid_account(` +
            `$select=name,accountid,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country` +
            `)` +
            `)` +
            `),regardingobjectid_opportunity(` +
            `$select=name,opportunityid,estimatedvalue,stepname,estimatedclosedate,_ownerid_value,prioritycode;` +
            `$expand=parentaccountid(` +
            `$select=name,accountid,address1_line1,address1_city,address1_stateorprovince,address1_postalcode,address1_country` +
            `)` +
            `)` +
            `&$filter=_${this._planLookupField}_value eq ${planId} and (statecode eq 0 or statecode eq 1)` +
            `&$orderby=${this._visitOrderField} asc,scheduledstart asc`;

        const result = await context.webAPI.retrieveMultipleRecords("appointment", options, 100);

        // Client-side safety filter: keep Open (0), Scheduled (3) and Completed (1)
        const activeEntities = result.entities.filter(
            (e) => e["statecode"] === 0 || e["statecode"] === 1 || e["statecode"] === 3
        );

        this._visits = activeEntities.map((e) => {
            const { accountName, address, accountId, accountCity } = getAccountAddress(e);
            return {
                id: e["activityid"] as string,
                subject: (e["subject"] as string) || "(No subject)",
                scheduledStart: new Date(e["scheduledstart"] as string),
                scheduledEnd: e["scheduledend"] ? new Date(e["scheduledend"] as string) : null,
                location: (e["location"] as string) || "",
                accountName,
                accountId,
                address,
                lat: null,
                lng: null,
                geocodeError: false,
                driveSec: null,
                driveMeters: null,
                eta: null,
                opportunityId: null,
                opportunityName: null,
                isPriority: e[this._isPriorityField] === true,
                invitationStatus: getInvitationStatus(e, this._invitationStatusField),
                accountCity,
                estimatedValue: null,
                salesStage: null,
                estimatedCloseDate: null,
                ownerName: null,
                regardingType: (e["_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname"] as string) ?? null,
                actualstart: e["actualstart"] ? new Date(e["actualstart"] as string) : null,
                statecode: typeof e["statecode"] === "number" ? (e["statecode"] as number) : 0,
                actualend: e["actualend"] ? new Date(e["actualend"] as string) : null,
            };
        });

        // Populate opportunity from Regarding field (type=opportunity)
        for (const entity of activeEntities) {
            const regardingType = entity["_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname"];
            if (regardingType === "opportunity") {
                const visit = this._visits.find((v) => v.id === entity["activityid"]);
                if (visit) {
                    visit.opportunityId = entity["_regardingobjectid_value"] as string;
                    visit.opportunityName =
                        (entity["_regardingobjectid_value@OData.Community.Display.V1.FormattedValue"] as string)
                        ?? null;
                    const opp = entity.regardingobjectid_opportunity;
                    if (opp) {
                        visit.estimatedValue = (opp["estimatedvalue"] as number) ?? null;
                        visit.salesStage = (opp["stepname"] as string) ?? null;
                        visit.estimatedCloseDate = (opp["estimatedclosedate"] as string) ?? null;
                        visit.ownerName = (opp["_ownerid_value@OData.Community.Display.V1.FormattedValue"] as string) ?? null;
                        if (opp["prioritycode"] === 1) visit.isPriority = true;
                    }
                }
            }
        }

        // Sort by visit order first, then by start time as tiebreaker
        this._visits.sort((a, b) => {
            const orderA = this._visits.indexOf(a);
            const orderB = this._visits.indexOf(b);
            // _visits were built from activeEntities which was already ordered
            // by vis_new_visitorder asc, scheduledstart asc from the API
            return orderA - orderB;
        });
    }

    /* ───────────────── OPPORTUNITY FETCH ───────────────── */

    private async _fetchOpportunities(): Promise<void> {
        // Opportunities are now read from the Regarding field on the appointment.
        // If any visits still have no opportunity name (formatted value not returned),
        // try to resolve the name from the opportunity record directly.
        if (!this._context) return;
        await Promise.all(
            this._visits.map(async (visit) => {
                if (!visit.opportunityId || visit.opportunityName || !this._context) return;
                try {
                    const opp = await this._context.webAPI.retrieveRecord(
                        "opportunity",
                        visit.opportunityId,
                        "?$select=name,estimatedvalue,stepname,estimatedclosedate,_ownerid_value,prioritycode"
                    );
                    visit.opportunityName = (opp["name"] as string) ?? null;
                    if (visit.estimatedValue == null) visit.estimatedValue = (opp["estimatedvalue"] as number) ?? null;
                    if (!visit.salesStage) visit.salesStage = (opp["stepname"] as string) ?? null;
                    if (!visit.estimatedCloseDate) visit.estimatedCloseDate = (opp["estimatedclosedate"] as string) ?? null;
                    if (!visit.ownerName) visit.ownerName = (opp["_ownerid_value@OData.Community.Display.V1.FormattedValue"] as string) ?? null;
                    if (opp["prioritycode"] === 1) visit.isPriority = true;
                } catch (err) {
                    console.error("[SVP] Failed to resolve opportunity name for", visit.opportunityId, err);
                }
            })
        );
    }

    /* ───────────────── NAVIGATION ───────────────── */

    private async _toggleVisitCheckInOut(appointmentId: string, isCheckOut: boolean): Promise<void> {
        try {
            const now = new Date().toISOString();
            const payload = isCheckOut
                ? { actualend: now, statecode: 1, statuscode: 3 }
                : { actualstart: now };
            await this._context!.webAPI.updateRecord("appointment", appointmentId, payload);

            const v = this._visits.find((x) => x.id === appointmentId);
            if (v) {
                if (isCheckOut) {
                    v.statecode = 1;
                    v.actualend = new Date();
                } else {
                    v.actualstart = new Date();
                }
            }
            this._renderList();
            // Reflect the new state on the map without a full re-render.
            this._refreshMapAfterStateChange();
            this._renderJourneySummary();
            // After Check Out, if the visit is linked to an opportunity,
            // offer to capture a structured visit note.
            if (isCheckOut) {
                const v = this._visits.find((x) => x.id === appointmentId);
                if (v && v.opportunityId) {
                    this._showVisitNoteModal(v);
                }
            }
        } catch (err) {
            console.error("[SVP] check in/out failed", err);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = ((err as any)?.message as string) ?? String(err);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const xrm: any = (window as any).Xrm ?? (window as any).parent?.Xrm ?? (window as any).top?.Xrm;
            xrm?.Navigation?.openErrorDialog?.({ message: msg });
        }
    }

    private _navigateToRecord(entityName: string, entityId: string): void {
        console.log(`[SVP] _navigateToRecord: ${entityName} / ${entityId}`);

        // Try to find the Xrm global — PCF iframes don't expose it on `window`,
        // but the parent (model-driven app shell) typically does.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const xrm: any =
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).Xrm ??
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).parent?.Xrm ??
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).top?.Xrm;

        if (xrm?.Navigation?.openForm) {
            console.log("[SVP] Using Xrm.Navigation.openForm (dialog)");
            xrm.Navigation.openForm(
                { entityName, entityId },
                { target: 2, position: 1, width: { value: 70, unit: "%" }, height: { value: 80, unit: "%" } }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ).catch((err: any) => console.error("[SVP] openForm error:", err));
            return;
        }

        // Fallback: PCF context.navigation.openForm (no dialog support, opens inline)
        if (this._context?.navigation) {
            console.log("[SVP] Falling back to context.navigation.openForm");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this._context.navigation as any).openForm({ entityName, entityId });
            return;
        }

        // Last resort: open in a new browser tab
        console.log("[SVP] Last resort: window.open");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const baseUrl = (this._context as any)?.page?.getClientUrl?.()
            || window.location.origin;
        const cleanId = entityId.replace(/[{}]/g, "");
        window.open(
            `${baseUrl}/main.aspx?etn=${encodeURIComponent(entityName)}&id=${encodeURIComponent(cleanId)}&pagetype=entityrecord`,
            "_blank"
        );
    }

    /* ───────────────── EXTERNAL MAPS / NAVIGATION ───────────────── */

    /**
     * Returns the best destination string we can hand to a maps app for `v`.
     * Prefers exact coordinates ("lat,lng") so the maps app doesn't have to
     * geocode again, falls back to the postal address.
     */
    private _buildNavTarget(v: VisitItem): string | null {
        if (typeof v.lat === "number" && typeof v.lng === "number"
            && !Number.isNaN(v.lat) && !Number.isNaN(v.lng)) {
            return `${v.lat},${v.lng}`;
        }
        const addr = (v.address ?? "").trim();
        return addr ? addr : null;
    }

    /**
     * Opens the device-native maps app with turn-by-turn directions to `target`.
     * `target` is either "lat,lng" or a postal address string.
     *
     * - iOS  → Apple Maps (maps://?daddr=...)
     * - Android / desktop / fallback → Google Maps universal link
     *   (https://www.google.com/maps/dir/?api=1&destination=...)
     *
     * We always open a Google Maps fallback in a new tab as well, so on iOS
     * if Apple Maps isn't installed (rare) the user still lands somewhere useful.
     */
    private _openNavigation(target: string): void {
        const encoded = encodeURIComponent(target);
        const ua = navigator.userAgent || "";
        const isIOS = /iPad|iPhone|iPod/.test(ua) && !("MSStream" in window);
        const googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${encoded}&travelmode=driving`;

        if (isIOS) {
            // Apple Maps deep link. We use a hidden anchor so Safari treats
            // it as a true user-gesture navigation (window.location works too,
            // but anchors are more reliable inside iframes).
            const a = document.createElement("a");
            a.href = `maps://?daddr=${encoded}&dirflg=d`;
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
            return;
        }

        // Android, desktop, and unknown clients: open Google Maps in a new tab.
        // On Android this triggers the native app intent automatically.
        window.open(googleUrl, "_blank", "noopener");
    }

    /* ───────────────── GEOCODING (Azure Maps Search) ───────────────── */

    private async _geocodeAll(): Promise<void> {
        console.log(`[SVP] _geocodeAll: geocoding ${this._visits.length} visits`);
        for (const visit of this._visits) {
            if (!visit.address || !visit.address.trim()) {
                console.warn(`[SVP] _geocodeAll: no address for visit ${visit.id} (${visit.accountName ?? visit.subject}) — skipping`);
                visit.geocodeError = true;
                continue;
            }
            try {
                console.log(`[SVP] _geocodeAll: geocoding "${visit.address}" for visit ${visit.id} (${visit.accountName ?? visit.subject})`);
                const encoded = encodeURIComponent(visit.address);
                // Try structured address search first, fall back to fuzzy search
                const addressUrl =
                    `https://atlas.microsoft.com/search/address/json` +
                    `?api-version=1.0&query=${encoded}` +
                    `&subscription-key=${this._azureMapsKey}&limit=1&countrySet=${this._geocodeCountrySet}`;
                const resp = await fetch(addressUrl, {
                    headers: { "Accept": "application/json" },
                });

                console.log(`[SVP] _geocodeAll: HTTP ${resp.status} for "${visit.address}"`);

                if (!resp.ok) {
                    const errorBody = await resp.text();
                    console.error(`[SVP] _geocodeAll: API error ${resp.status}: ${errorBody.substring(0, 300)}`);
                    visit.geocodeError = true;
                    continue;
                }

                const data: AzureMapsSearchResponse = await resp.json();
                if (data.results && data.results.length > 0) {
                    visit.lat = data.results[0].position.lat;
                    visit.lng = data.results[0].position.lon;
                    console.log(`[SVP] _geocodeAll: OK lat=${visit.lat} lng=${visit.lng}`);
                } else {
                    // Fallback: fuzzy search is more permissive
                    console.warn(`[SVP] _geocodeAll: no structured results for "${visit.address}" — trying fuzzy search`);
                    const fuzzyUrl =
                        `https://atlas.microsoft.com/search/fuzzy/json` +
                        `?api-version=1.0&query=${encoded}` +
                        `&subscription-key=${this._azureMapsKey}&limit=1`;
                    const fuzzyResp = await fetch(fuzzyUrl, { headers: { "Accept": "application/json" } });
                    console.log(`[SVP] _geocodeAll: fuzzy HTTP ${fuzzyResp.status}`);
                    if (fuzzyResp.ok) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const fuzzyData: any = await fuzzyResp.json();
                        if (fuzzyData.results && fuzzyData.results.length > 0) {
                            visit.lat = fuzzyData.results[0].position.lat;
                            visit.lng = fuzzyData.results[0].position.lon;
                            console.log(`[SVP] _geocodeAll: fuzzy OK lat=${visit.lat} lng=${visit.lng}`);
                        } else {
                            console.warn(`[SVP] _geocodeAll: fuzzy also returned no results for "${visit.address}"`);
                            visit.geocodeError = true;
                        }
                    } else {
                        const fuzzyErr = await fuzzyResp.text();
                        console.error(`[SVP] _geocodeAll: fuzzy error ${fuzzyResp.status}: ${fuzzyErr.substring(0, 300)}`);
                        visit.geocodeError = true;
                    }
                }
            } catch (err) {
                console.error(`[SVP] _geocodeAll: exception for "${visit.address}":`, err);
                visit.geocodeError = true;
            }
        }
    }

    /* ───────────────── RENDER LIST (TIMELINE) ───────────────── */

    private _renderList(): void {
        if (this._visits.length === 0) {
            this._showEmptyState();
            return;
        }

        const items = this._buildTimelineItems();
        const fragments: string[] = [];

        for (const item of items) {
            switch (item.type) {
                case "visit":
                    fragments.push(this._renderTimelineVisitHtml(item));
                    break;
                case "drive":
                    fragments.push(this._renderTimelineDriveHtml(item));
                    break;
                case "gap":
                    fragments.push(this._renderTimelineGapHtml(item));
                    break;
                case "boundary":
                    fragments.push(this._renderTimelineBoundaryHtml(item));
                    break;
            }
        }

        this._listBody.innerHTML =
            `<div class="svp-timeline">` +
            `<div class="svp-tl-rail"></div>` +
            fragments.join("") +
            `</div>`;

        this._wireTimelineHandlers();
    }

    /* ── Timeline item builder ── */

    private _buildTimelineItems(): TimelineItem[] {
        // Ensure chronological order by scheduledStart
        this._visits.sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());

        const items: TimelineItem[] = [];
        const ws = this._workStartMins;
        const we = this._workEndMins;
        const GAP_THRESHOLD = 45;

        const toMins = (d: Date) => d.getHours() * 60 + d.getMinutes();

        // Helper: create a Date on the same day as ref but at the given minute-of-day
        const minsToDate = (mins: number, ref: Date): Date => {
            const d = new Date(ref);
            d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
            return d;
        };

        // ── Work day start boundary ──
        items.push({
            type: "boundary",
            boundaryLabel: `Work day starts ${this._fmtMins(ws)}`,
            boundaryMins: ws,
        });

        // ── Gap before first visit ──
        if (this._visits.length > 0) {
            const firstMins = toMins(this._visits[0].scheduledStart);
            if (firstMins - ws >= GAP_THRESHOLD) {
                items.push({
                    type: "gap",
                    gapStart: minsToDate(ws, this._visits[0].scheduledStart),
                    gapEnd: this._visits[0].scheduledStart,
                    gapMinutes: firstMins - ws,
                    previousCity: null,
                });
            }
        }

        // ── Build visit + drive + gap items ──
        let workEndInserted = false;

        for (let i = 0; i < this._visits.length; i++) {
            const current = this._visits[i];

            // Insert work-end boundary before a visit that starts at or after workEnd
            if (!workEndInserted && toMins(current.scheduledStart) >= we) {
                items.push({
                    type: "boundary",
                    boundaryLabel: `Work day ends ${this._fmtMins(we)}`,
                    boundaryMins: we,
                });
                workEndInserted = true;
            }

            items.push({ type: "visit", visit: current, visitIndex: i });

            if (i < this._visits.length - 1) {
                const next = this._visits[i + 1];
                const driveSec = next.driveSec
                    ?? this._optimizedLegSummaries[i]?.travelTimeSeconds
                    ?? (this._legSummaries[i]?.travelTimeSeconds ?? 0);
                const driveM = next.driveMeters ?? (this._legSummaries[i]?.lengthInMeters ?? 0);

                items.push({ type: "drive", driveSeconds: driveSec, driveMeters: driveM });

                // Clamped gap detection — use minute-of-day values within working hours
                const visitEnd = current.scheduledEnd ?? current.scheduledStart;
                const prevEndMins = toMins(visitEnd) + Math.round(driveSec / 60);
                const nextStartMins = toMins(next.scheduledStart);
                const effectiveStart = Math.max(prevEndMins, ws);
                const effectiveEnd = Math.min(nextStartMins, we);
                const freeMin = Math.max(0, effectiveEnd - effectiveStart);

                if (freeMin >= GAP_THRESHOLD) {
                    items.push({
                        type: "gap",
                        gapStart: minsToDate(effectiveStart, visitEnd),
                        gapEnd: minsToDate(effectiveEnd, visitEnd),
                        gapMinutes: freeMin,
                        previousCity: current.accountCity,
                    });
                }

                // Insert work-end boundary between visits if it falls in the gap
                if (!workEndInserted && toMins(visitEnd) <= we && toMins(next.scheduledStart) >= we) {
                    items.push({
                        type: "boundary",
                        boundaryLabel: `Work day ends ${this._fmtMins(we)}`,
                        boundaryMins: we,
                    });
                    workEndInserted = true;
                }
            }
        }

        // ── Gap after last visit ──
        if (this._visits.length > 0) {
            const lastApt = this._visits[this._visits.length - 1];
            const lastEnd = lastApt.scheduledEnd ?? lastApt.scheduledStart;
            const lastEndMins = toMins(lastEnd);
            if (we - lastEndMins >= GAP_THRESHOLD) {
                items.push({
                    type: "gap",
                    gapStart: lastEnd,
                    gapEnd: minsToDate(we, lastEnd),
                    gapMinutes: we - lastEndMins,
                    previousCity: lastApt.accountCity,
                });
            }
        }

        // ── Work day end boundary (if not already inserted) ──
        if (!workEndInserted) {
            items.push({
                type: "boundary",
                boundaryLabel: `Work day ends ${this._fmtMins(we)}`,
                boundaryMins: we,
            });
        }

        return items;
    }

    /* ── Timeline HTML renderers ── */

    private _renderTimelineVisitHtml(item: TimelineItem): string {
        const v = item.visit!;
        const startTime = v.scheduledStart.toLocaleTimeString("en-GB", {
            hour: "2-digit", minute: "2-digit",
        });
        const time = this._formatTimeRange(v.scheduledStart, v.scheduledEnd);
        const accountLabel = v.accountName
            ? this._escapeHtml(v.accountName)
            : this._escapeHtml(v.subject);
        const isDeclined = v.invitationStatus === STATUS.invitation.declined;
        const declinedClass = isDeclined ? " svp-tl-declined" : "";
        const priorityClass = v.isPriority ? " priority-card-active" : "";
        const isCompleted = v.statecode === 1;
        const isInProgress = !isCompleted && !!v.actualstart;
        const completedClass = isCompleted ? " svp-tl-card--completed" : (isInProgress ? " svp-tl-card--inprogress" : "");

        // Node dot color
        let dotClass = "svp-tl-dot-default";
        if (isCompleted) dotClass = "svp-tl-dot--done";
        else if (isInProgress) dotClass = "svp-tl-dot--inprogress";
        else if (isDeclined) dotClass = "svp-tl-dot-declined";
        else if (v.invitationStatus === STATUS.invitation.accepted) dotClass = "svp-tl-dot-accepted";
        else if (v.invitationStatus === STATUS.invitation.invited) dotClass = "svp-tl-dot-invited";
        else if (v.isPriority) dotClass = "svp-tl-dot-priority";

        // Invitation pill
        const invPill = this._getInvitationStatusPill(v.invitationStatus);

        // Outside working hours badge
        const outsideBadge = this._isOutsideWorkingHours(v)
            ? `<span class="svp-badge-outside-hours">Outside hours</span>`
            : "";

        // Address — truncated for compactness
        const addrLabel = v.address ? this._escapeHtml(v.address) : "";

        // --- Collapsed row: [main: header(title + badges) + subtitle] | chevron ---
        const collapsedHtml =
            `<div class="svp-tl-card-collapsed">` +
            `<div class="svp-tl-card-collapsed-main">` +
            `<div class="svp-tl-card-header">` +
            `<div class="svp-tl-card-title" title="${accountLabel}">${accountLabel}</div>` +
            `<div class="svp-tl-card-badges">${outsideBadge}${invPill}</div>` +
            `</div>` +
            `<div class="svp-tl-card-subtitle">${this._escapeHtml(time)}${addrLabel ? ` \u00B7 ${addrLabel}` : ""}</div>` +
            `</div>` +
            `<div class="svp-tl-card-collapsed-end">` +
            `<span class="svp-tl-chevron">\u203A</span>` +
            `</div>` +
            `</div>`;

        // --- Expanded detail grid ---
        let detailGrid: string;
        if (v.regardingType === "opportunity" && v.opportunityId) {
            const oppName = v.opportunityName ? this._escapeHtml(v.opportunityName) : "\u2014";
            const estVal = v.estimatedValue != null
                ? `DKK ${v.estimatedValue.toLocaleString("da-DK")}`
                : "\u2014";
            const stage = v.salesStage ? this._escapeHtml(v.salesStage) : "\u2014";
            const closeDate = v.estimatedCloseDate
                ? new Date(v.estimatedCloseDate).toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric" })
                : "\u2014";
            const owner = v.ownerName ? this._escapeHtml(v.ownerName) : "\u2014";
            const prioLabel = v.isPriority ? "High" : "Normal";

            detailGrid =
                `<div class="svp-tl-detail-grid">` +
                `<div class="svp-tl-detail-cell"><div class="svp-tl-detail-label">Opportunity</div><div class="svp-tl-detail-value">${oppName}</div></div>` +
                `<div class="svp-tl-detail-cell"><div class="svp-tl-detail-label">Est. value</div><div class="svp-tl-detail-value">${estVal}</div></div>` +
                `<div class="svp-tl-detail-cell"><div class="svp-tl-detail-label">Stage</div><div class="svp-tl-detail-value">${stage}</div></div>` +
                `<div class="svp-tl-detail-cell"><div class="svp-tl-detail-label">Close date</div><div class="svp-tl-detail-value">${closeDate}</div></div>` +
                `<div class="svp-tl-detail-cell"><div class="svp-tl-detail-label">Account owner</div><div class="svp-tl-detail-value">${owner}</div></div>` +
                `<div class="svp-tl-detail-cell"><div class="svp-tl-detail-label">Priority</div><div class="svp-tl-detail-value">${prioLabel}</div></div>` +
                `</div>`;
        } else {
            detailGrid = `<div class="svp-tl-no-opportunity">No linked opportunity</div>`;
        }

        // --- Action buttons ---
        // Inline 16x16 SVGs (currentColor so they inherit the button text colour).
        const ICON_CHECKIN  = `<svg class="svp-tl-btn-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5"/><path d="M5 1.75v3M11 1.75v3M2.25 6.5h11.5"/><path d="M6 10l1.7 1.7L11 8.4"/></svg>`;
        const ICON_NAV      = `<svg class="svp-tl-btn-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M8 4l2.4 5.6L8 8.6 5.6 9.6z" fill="currentColor" stroke="none"/></svg>`;
        const ICON_APPT     = `<svg class="svp-tl-btn-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5"/><path d="M5 1.75v3M11 1.75v3M2.25 6.5h11.5"/></svg>`;
        const ICON_EXTLINK  = `<svg class="svp-tl-btn-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L7 9"/><path d="M12.25 9v3.75A1.5 1.5 0 0 1 10.75 14.25h-7A1.5 1.5 0 0 1 2.25 12.75v-7A1.5 1.5 0 0 1 3.75 4.25H7"/></svg>`;
        const ICON_REMOVE   = `<svg class="svp-tl-btn-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10"/><path d="M6.25 4.5V3.25A1 1 0 0 1 7.25 2.25h1.5A1 1 0 0 1 9.75 3.25V4.5"/><path d="M4.5 4.5l.75 8.5A1.5 1.5 0 0 0 6.74 14.5h2.5a1.5 1.5 0 0 0 1.5-1.5l.76-8.5"/></svg>`;
        const ICON_CANCEL   = `<svg class="svp-tl-btn-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>`;

        let checkBtn: string;
        if (isCompleted) {
            const endLabel = v.actualend
                ? v.actualend.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })
                : "";
            checkBtn = `<span class="svp-tl-completed-label">\u2713 Completed${endLabel ? ` ${this._escapeHtml(endLabel)}` : ""}</span>`;
        } else if (isInProgress) {
            checkBtn = `<button class="svp-tl-action-btn svp-tl-btn--primary svp-tl-checkout-btn" data-appointmentid="${this._escapeHtml(v.id)}">${ICON_CHECKIN}<span class="svp-tl-btn-label">Check Out</span></button>`;
        } else {
            checkBtn = `<button class="svp-tl-action-btn svp-tl-btn--primary svp-tl-checkin-btn" data-appointmentid="${this._escapeHtml(v.id)}">${ICON_CHECKIN}<span class="svp-tl-btn-label">Check In</span></button>`;
        }
        const openApptBtn = `<button class="svp-tl-action-btn svp-tl-open-appt" data-entity="appointment" data-id="${this._escapeHtml(v.id)}">${ICON_APPT}<span class="svp-tl-btn-label">Open appointment</span></button>`;
        const openOppBtn = v.opportunityId
            ? `<button class="svp-tl-action-btn svp-tl-open-opp" data-entity="opportunity" data-id="${this._escapeHtml(v.opportunityId)}">${ICON_EXTLINK}<span class="svp-tl-btn-label">Open opportunity</span></button>`
            : "";
        // "Navigate" — opens device-native maps app (Apple Maps on iOS, Google Maps elsewhere)
        // with turn-by-turn directions to the visit address. Hidden once completed.
        const navTarget = this._buildNavTarget(v);
        const navBtn = (!isCompleted && navTarget)
            ? `<button class="svp-tl-action-btn svp-tl-nav-btn" data-nav-target="${this._escapeHtml(navTarget)}" title="Open directions in your maps app">${ICON_NAV}<span class="svp-tl-btn-label">Navigate</span></button>`
            : "";
        const removeBtn = isDeclined
            ? `<button class="svp-tl-action-btn svp-tl-remove-btn" data-appointmentid="${this._escapeHtml(v.id)}" data-city="${this._escapeHtml(v.accountCity ?? "")}" data-start="${v.scheduledStart.toISOString()}" data-end="${(v.scheduledEnd ?? v.scheduledStart).toISOString()}">${ICON_REMOVE}<span class="svp-tl-btn-label">Remove from plan</span></button>`
            : "";
        // "Cancel" — cancels the appointment in Dynamics (statecode = Canceled).
        // Only shown for active/open appointments; hidden once completed or declined
        // (declined appointments use the "Remove from plan" button instead).
        const cancelBtn = (!isCompleted && !isDeclined)
            ? `<button class="svp-tl-action-btn svp-tl-cancel-btn" data-appointmentid="${this._escapeHtml(v.id)}" data-subject="${this._escapeHtml(v.subject)}" title="Cancel this appointment">${ICON_CANCEL}<span class="svp-tl-btn-label">Cancel</span></button>`
            : "";

        const expandedHtml =
            `<div class="svp-tl-card-expanded">` +
            detailGrid +
            `<div class="svp-tl-action-row">${checkBtn}${navBtn}${openApptBtn}${openOppBtn}${removeBtn}${cancelBtn}</div>` +
            `</div>`;

        return `<div class="svp-tl-item svp-tl-visit-item${declinedClass}${priorityClass}" data-appointment-id="${this._escapeHtml(v.id)}">` +
            `<div class="svp-tl-time">${startTime}</div>` +
            `<div class="svp-tl-dot ${dotClass}"></div>` +
            `<div class="svp-tl-card${completedClass}" data-activityid="${this._escapeHtml(v.id)}">` +
            collapsedHtml + expandedHtml +
            `</div></div>`;
    }

    private _renderTimelineDriveHtml(item: TimelineItem): string {
        const secs = item.driveSeconds ?? 0;
        const meters = item.driveMeters ?? 0;
        if (secs === 0 && meters === 0) {
            return `<div class="svp-tl-item svp-tl-drive-item">` +
                `<div class="svp-tl-time"></div>` +
                `<div class="svp-tl-dot-spacer"></div>` +
                `<div class="svp-tl-drive-label svp-tl-drive-pending">\u2193 Drive time unknown</div>` +
                `</div>`;
        }
        return `<div class="svp-tl-item svp-tl-drive-item">` +
            `<div class="svp-tl-time"></div>` +
            `<div class="svp-tl-dot-spacer"></div>` +
            `<div class="svp-tl-drive-label">\u2193 ${formatDuration(secs)} drive (${formatDistance(meters)})</div>` +
            `</div>`;
    }

    private _renderTimelineBoundaryHtml(item: TimelineItem): string {
        const timeStr = this._fmtMins(item.boundaryMins ?? 0);
        return `<div class="svp-tl-item svp-tl-boundary-item">` +
            `<div class="svp-tl-time svp-tl-boundary-time">${timeStr}</div>` +
            `<div class="svp-tl-boundary-line"></div>` +
            `<div class="svp-tl-boundary-label">${this._escapeHtml(item.boundaryLabel ?? "")}</div>` +
            `</div>`;
    }

    private _renderTimelineGapHtml(item: TimelineItem): string {
        const startStr = item.gapStart!.toLocaleTimeString("en-GB", {
            hour: "2-digit", minute: "2-digit",
        });
        const hours = Math.floor((item.gapMinutes ?? 0) / 60);
        const mins = (item.gapMinutes ?? 0) % 60;
        const durationLabel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        const city = item.previousCity ?? "";
        const gapStartIso = item.gapStart!.toISOString();
        const gapEndIso = item.gapEnd!.toISOString();

        return `<div class="svp-tl-item svp-tl-gap-item">` +
            `<div class="svp-tl-time">${startStr}</div>` +
            `<div class="svp-tl-dot svp-tl-dot-gap"></div>` +
            `<div class="svp-tl-card svp-tl-gap-card">` +
            `<div class="svp-tl-gap-content">` +
            `<div class="svp-tl-gap-label">Free slot \u2014 ${durationLabel} available</div>` +
            `<div class="svp-tl-gap-hint">High priority opportunity nearby?</div>` +
            `</div>` +
            `<button class="svp-tl-gap-btn" data-gap-start="${gapStartIso}" data-gap-end="${gapEndIso}" data-city="${this._escapeHtml(city)}">Find opportunity \u2197</button>` +
            `</div></div>`;
    }

    /* ── Timeline event wiring ── */

    private _wireTimelineHandlers(): void {
        // Accordion: click card to expand/collapse (only one open at a time)
        this._listBody.querySelectorAll(".svp-tl-card[data-activityid]").forEach((el) => {
            el.addEventListener("click", (e) => {
                // Don't toggle if clicking a button inside the card
                if ((e.target as HTMLElement).closest("button")) return;
                const card = el as HTMLElement;
                const isOpen = card.classList.contains("svp-tl-card-open");

                // Collapse any currently open card
                this._listBody.querySelectorAll(".svp-tl-card-open").forEach((c) => {
                    c.classList.remove("svp-tl-card-open");
                });

                // Toggle this one
                if (!isOpen) card.classList.add("svp-tl-card-open");
            });
        });

        // Action buttons inside expanded cards
        this._listBody.querySelectorAll(".svp-tl-open-appt, .svp-tl-open-opp").forEach((el) => {
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                const btn = e.currentTarget as HTMLElement;
                const entity = btn.dataset.entity ?? "";
                const id = btn.dataset.id ?? "";
                if (entity && id) this._navigateToRecord(entity, id);
            });
        });

        // "Navigate" buttons — open device-native maps app for directions
        this._listBody.querySelectorAll(".svp-tl-nav-btn").forEach((el) => {
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                const btn = e.currentTarget as HTMLElement;
                const target = btn.dataset.navTarget ?? "";
                if (target) this._openNavigation(target);
            });
        });

        // Check In / Check Out buttons
        this._listBody.querySelectorAll(".svp-tl-checkin-btn, .svp-tl-checkout-btn").forEach((el) => {
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                const btn = e.currentTarget as HTMLElement;
                const id = btn.dataset.appointmentid;
                const isCheckOut = btn.classList.contains("svp-tl-checkout-btn");
                if (id) void this._toggleVisitCheckInOut(id, isCheckOut);
            });
        });

        // Opportunity links in map banner
        this._listBody.querySelectorAll(".svp-opportunity-link").forEach((el) => {
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                const id = (e.currentTarget as HTMLElement).dataset.opportunityid;
                if (id) this._navigateToRecord("opportunity", id);
            });
        });

        // Gap slot "Find opportunity" buttons
        this._listBody.querySelectorAll(".svp-tl-gap-btn").forEach((el) => {
            el.addEventListener("click", (e) => {
                const btn = e.currentTarget as HTMLElement;
                const gapStart = new Date(btn.dataset.gapStart ?? "");
                const gapEnd = new Date(btn.dataset.gapEnd ?? "");
                const city = btn.dataset.city || null;
                this.findNearbyOpportunities(gapStart, gapEnd, city);
            });
        });

        // Remove buttons on declined cards
        this._listBody.querySelectorAll(".svp-tl-remove-btn").forEach((el) => {
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                const btn = e.currentTarget as HTMLElement;
                const appointmentId = btn.dataset.appointmentid;
                const city = btn.dataset.city || null;
                const start = btn.dataset.start ?? "";
                const end = btn.dataset.end ?? "";
                if (appointmentId) {
                    this._removeDeclinedVisit(appointmentId, city, new Date(start), new Date(end));
                }
            });
        });

        // Cancel buttons — cancel the appointment in Dynamics
        this._listBody.querySelectorAll(".svp-tl-cancel-btn").forEach((el) => {
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                const btn = e.currentTarget as HTMLElement;
                const appointmentId = btn.dataset.appointmentid;
                const subject = btn.dataset.subject ?? "";
                if (appointmentId) void this._cancelVisit(appointmentId, subject);
            });
        });
    }

    /* ── Remove declined visit from plan ── */

    private async _removeDeclinedVisit(
        appointmentId: string, city: string | null, scheduledStart: Date, scheduledEnd: Date
    ): Promise<void> {
        if (!this._context) return;

        // Find the timeline item wrapper
        const itemEl = this._listBody.querySelector(
            `.svp-tl-visit-item[data-appointment-id="${appointmentId}"]`
        ) as HTMLElement | null;

        try {
            // Unlink appointment from Visit Plan by DELETEing the single-valued navigation property ref
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const clientUrl = ((this._context as any).page?.getClientUrl?.() as string)
                || window.location.origin;
            const url = `${clientUrl}/api/data/v9.2/appointments(${appointmentId})/${this._planLookupNav}/$ref`;
            const resp = await fetch(url, { method: "DELETE" });
            if (!resp.ok && resp.status !== 204) {
                throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
            }

            // Animate the card out
            if (itemEl) {
                itemEl.classList.add("svp-tl-removing");
                // Wait for CSS transition to finish
                await new Promise((resolve) => setTimeout(resolve, 350));
            }

            // Remove from internal visits array
            this._visits = this._visits.filter((v) => v.id !== appointmentId);

            // Recalculate the route with the remaining visits
            await this._calculateRoute();

            // Re-render the timeline — this will naturally create gap cards where free slots exist
            this._renderList();
            this._renderJourneySummary();
            this._renderMap();

            // Show inline confirmation
            this._showMapBanner(
                "\u2705 Removed from visit plan. Route recalculated.", "info"
            );

            // If the freed slot is big enough, trigger opportunity search
            const gapMs = scheduledEnd.getTime() - scheduledStart.getTime();
            if (gapMs >= 45 * 60 * 1000) {
                this.findNearbyOpportunities(scheduledStart, scheduledEnd, city);
            }
        } catch (err) {
            console.error("[SVP] _removeDeclinedVisit error:", err);
            // Undo the animation if it started
            if (itemEl) itemEl.classList.remove("svp-tl-removing");
            this._showMapBanner("\u26A0\uFE0F Could not remove appointment from visit plan.", "error");
        }
    }

    /* ── Cancel appointment (statecode = Canceled) ── */

    /**
     * Cancels the given appointment in Dynamics by setting statecode=2 (Canceled),
     * statuscode=4 (Canceled). Confirms with the user first. The appointment record
     * itself is preserved (so it's auditable) — it just disappears from the visit
     * plan timeline because _fetchAppointments only loads statecode 0/1.
     */
    private async _cancelVisit(appointmentId: string, subject: string): Promise<void> {
        if (!this._context) return;

        // Confirm via Xrm.Navigation when available (model-driven host),
        // otherwise fall back to a native confirm().
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const xrm: any =
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).Xrm ??
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).parent?.Xrm ??
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).top?.Xrm;

        const promptText =
            `Cancel the appointment "${subject || "(no subject)"}"?\n\n` +
            `The appointment will be marked Canceled in Dynamics and removed from this visit plan.`;

        let confirmed = false;
        if (xrm?.Navigation?.openConfirmDialog) {
            try {
                const res = await xrm.Navigation.openConfirmDialog(
                    { title: "Cancel appointment", text: promptText, confirmButtonLabel: "Cancel appointment", cancelButtonLabel: "Keep" }
                );
                confirmed = !!res?.confirmed;
            } catch {
                confirmed = false;
            }
        } else {
            confirmed = window.confirm(promptText);
        }
        if (!confirmed) return;

        const itemEl = this._listBody.querySelector(
            `.svp-tl-visit-item[data-appointment-id="${appointmentId}"]`
        ) as HTMLElement | null;

        try {
            await this._context.webAPI.updateRecord("appointment", appointmentId, {
                statecode: 2,   // Canceled
                statuscode: 4,  // Canceled
            });

            if (itemEl) {
                itemEl.classList.add("svp-tl-removing");
                await new Promise((resolve) => setTimeout(resolve, 350));
            }

            // Drop from local state and re-render
            this._visits = this._visits.filter((v) => v.id !== appointmentId);
            await this._calculateRoute();
            this._renderList();
            this._renderJourneySummary();
            this._renderMap();

            this._showMapBanner("\u2705 Appointment canceled.", "info");
        } catch (err) {
            console.error("[SVP] _cancelVisit error:", err);
            if (itemEl) itemEl.classList.remove("svp-tl-removing");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = ((err as any)?.message as string) ?? String(err);
            if (xrm?.Navigation?.openErrorDialog) {
                xrm.Navigation.openErrorDialog({ message: "Could not cancel the appointment.\n\n" + msg });
            } else {
                this._showMapBanner("\u26A0\uFE0F Could not cancel the appointment.", "error");
            }
        }
    }

    /* ── Nearby opportunity search → inline picker panel ── */

    private async findNearbyOpportunities(gapStart: Date, gapEnd: Date, city: string | null): Promise<void> {
        if (!this._context) return;
        if (!city) {
            this._showMapBanner("\u26A0\uFE0F No city information \u2014 cannot search for nearby opportunities.", "warning");
            return;
        }

        // Find the gap card element to insert the picker below it
        const gapItem = this._listBody.querySelector(
            `.svp-tl-gap-btn[data-gap-start="${gapStart.toISOString()}"]`
        )?.closest(".svp-tl-gap-item") as HTMLElement | null;

        // Show loading state in the gap card
        if (gapItem) {
            const existing = gapItem.nextElementSibling;
            if (existing?.classList.contains("svp-opp-picker")) existing.remove();
            const loader = document.createElement("div");
            loader.className = "svp-opp-picker svp-opp-picker-loading";
            loader.innerHTML = `<div class="svp-opp-picker-header">Searching for opportunities in ${this._escapeHtml(city)}\u2026</div>`;
            gapItem.insertAdjacentElement("afterend", loader);
        }

        const safeCity = city.replace(/'/g, "''");
        const now = new Date();
        const sixtyDaysLater = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
        const closeDateFilter = sixtyDaysLater.toISOString().split("T")[0];

        try {
            const result = await this._context.webAPI.retrieveMultipleRecords(
                "opportunity",
                `?$select=name,estimatedvalue,estimatedclosedate,prioritycode,stepname` +
                `&$expand=parentaccountid($select=name,address1_city,address1_line1,address1_postalcode,address1_country)` +
                `&$filter=statecode eq 0` +
                ` and (prioritycode eq 1 or prioritycode eq 2)` +
                ` and estimatedclosedate le ${closeDateFilter}` +
                ` and parentaccountid/address1_city eq '${safeCity}'` +
                `&$orderby=prioritycode asc,estimatedvalue desc&$top=5`
            );

            // Remove loading panel
            if (gapItem) {
                const loader = gapItem.nextElementSibling;
                if (loader?.classList.contains("svp-opp-picker")) loader.remove();
            }

            if (result.entities.length === 0) {
                this._showMapBanner(
                    `\u2139\uFE0F No high priority opportunities found within 20 km of this slot.`, "info"
                );
                return;
            }

            // Build opportunity cards
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const opps: any[] = result.entities;
            this._renderOpportunityPicker(opps, gapStart, gapEnd, city, gapItem);

        } catch (err) {
            console.error("[SVP] findNearbyOpportunities error:", err);
            if (gapItem) {
                const loader = gapItem.nextElementSibling;
                if (loader?.classList.contains("svp-opp-picker")) loader.remove();
            }
            this._showMapBanner("\u26A0\uFE0F Could not search for opportunities.", "error");
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _renderOpportunityPicker(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        opps: any[], gapStart: Date, gapEnd: Date, city: string, gapItem: HTMLElement | null
    ): void {
        const timeLabel = `${gapStart.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} \u2013 ` +
            `${gapEnd.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

        const cards = opps.map((o, idx) => {
            const name = this._escapeHtml(o.name || "Unnamed");
            const id = o.opportunityid as string;
            const account = o.parentaccountid;
            const accName = account ? this._escapeHtml(account.name || "") : "";
            const accCity = account ? this._escapeHtml(account.address1_city || "") : "";
            const owner = this._escapeHtml((o["_ownerid_value@OData.Community.Display.V1.FormattedValue"] as string) || "");
            const stage = this._escapeHtml(o.stepname || "");
            const priority = o.prioritycode as number;
            const prioLabel = priority === 1 ? "High" : "Medium";
            const prioCls = priority === 1 ? "svp-opp-prio-high" : "svp-opp-prio-medium";
            const value = o.estimatedvalue != null
                ? new Intl.NumberFormat("da-DK", { style: "currency", currency: "DKK", maximumFractionDigits: 0 }).format(o.estimatedvalue)
                : "\u2014";
            const closeDate = o.estimatedclosedate
                ? new Date(o.estimatedclosedate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
                : "\u2014";
            const accAddr = account
                ? `${account.address1_line1 || ""}, ${account.address1_postalcode || ""} ${account.address1_city || ""}`.replace(/^,\s*/, "")
                : "";

            return `<div class="svp-opp-card" data-opp-index="${idx}" data-opp-id="${this._escapeHtml(id)}" ` +
                `data-acc-id="${account ? this._escapeHtml(account.accountid) : ""}" ` +
                `data-acc-name="${this._escapeHtml(accName)}" ` +
                `data-acc-addr="${this._escapeHtml(accAddr)}" ` +
                `data-acc-city="${this._escapeHtml(accCity)}">` +
                `<div class="svp-opp-card-row1">` +
                `<span class="svp-opp-name">${name}</span>` +
                `<span class="svp-opp-prio ${prioCls}">${prioLabel}</span>` +
                `</div>` +
                `<div class="svp-opp-card-row2">${accName}${accCity ? ` \u2014 ${accCity}` : ""}</div>` +
                `<div class="svp-opp-detail-grid">` +
                `<div class="svp-opp-detail-cell"><div class="svp-opp-detail-label">Est. value</div><div class="svp-opp-detail-value">${value}</div></div>` +
                `<div class="svp-opp-detail-cell"><div class="svp-opp-detail-label">Close date</div><div class="svp-opp-detail-value">${closeDate}</div></div>` +
                `<div class="svp-opp-detail-cell"><div class="svp-opp-detail-label">Stage</div><div class="svp-opp-detail-value">${stage || "\u2014"}</div></div>` +
                `<div class="svp-opp-detail-cell"><div class="svp-opp-detail-label">Owner</div><div class="svp-opp-detail-value">${owner || "\u2014"}</div></div>` +
                `</div>` +
                `<button class="svp-opp-add-btn" style="display:none">Add to plan</button>` +
                `<a class="svp-opp-open-link" data-opp-id="${this._escapeHtml(id)}">Open opportunity</a>` +
                `</div>`;
        }).join("");

        const panel = document.createElement("div");
        panel.className = "svp-opp-picker";
        panel.innerHTML =
            `<div class="svp-opp-picker-header">` +
            `<span>${opps.length} opportunit${opps.length > 1 ? "ies" : "y"} near ${this._escapeHtml(city)} \u2014 ${timeLabel}</span>` +
            `<button class="svp-opp-picker-close">\u2715</button>` +
            `</div>` +
            `<div class="svp-opp-picker-body">${cards}</div>`;

        // Insert below gap card
        if (gapItem) {
            gapItem.insertAdjacentElement("afterend", panel);
        } else {
            this._listBody.appendChild(panel);
        }

        // Wire card selection
        let selectedCard: HTMLElement | null = null;
        panel.querySelectorAll(".svp-opp-card").forEach((el) => {
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                const card = (e.currentTarget as HTMLElement);
                // Deselect previous
                if (selectedCard) {
                    selectedCard.classList.remove("svp-opp-card-selected");
                    const prevBtn = selectedCard.querySelector(".svp-opp-add-btn") as HTMLElement;
                    if (prevBtn) prevBtn.style.display = "none";
                }
                // Select new
                if (selectedCard === card) {
                    selectedCard = null;
                    return;
                }
                selectedCard = card;
                card.classList.add("svp-opp-card-selected");
                const btn = card.querySelector(".svp-opp-add-btn") as HTMLElement;
                if (btn) btn.style.display = "";
            });
        });

        // Wire "Add to plan" buttons
        panel.querySelectorAll(".svp-opp-add-btn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const card = (e.currentTarget as HTMLElement).closest(".svp-opp-card") as HTMLElement;
                const oppId = card.dataset.oppId ?? "";
                const accId = card.dataset.accId ?? "";
                const accName = card.dataset.accName ?? "";
                const accAddr = card.dataset.accAddr ?? "";
                const accCity = card.dataset.accCity ?? "";
                this._addOpportunityToPlan(oppId, accId, accName, accAddr, accCity, gapStart, gapEnd, panel);
            });
        });

        // Wire "Open opportunity" buttons
        panel.querySelectorAll(".svp-opp-open-link").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const oppId = (e.currentTarget as HTMLElement).dataset.oppId ?? "";
                if (oppId) this._navigateToRecord("opportunity", oppId);
            });
        });

        // Wire close button
        panel.querySelector(".svp-opp-picker-close")?.addEventListener("click", () => {
            panel.remove();
        });
    }

    private async _addOpportunityToPlan(
        opportunityId: string, accountId: string, accountName: string,
        accountAddress: string, accountCity: string,
        gapStart: Date, gapEnd: Date,
        pickerPanel: HTMLElement
    ): Promise<void> {
        if (!this._context || !this._planId) return;

        // Disable buttons while working
        pickerPanel.querySelectorAll(".svp-opp-add-btn").forEach((b) => {
            (b as HTMLButtonElement).disabled = true;
            b.textContent = "Adding\u2026";
        });

        try {
            // 1. Create appointment linked to opportunity and account, on the visit plan
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const appointmentData: Record<string, any> = {
                subject: `Sales Visit \u2014 ${accountName}`,
                scheduledstart: gapStart.toISOString(),
                scheduledend: gapEnd.toISOString(),
                location: accountAddress,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                "regardingobjectid_opportunity@odata.bind": `/opportunities(${opportunityId})`,
            };
            appointmentData[`${this._planLookupNav}@odata.bind`] = `/${this._planCollection}(${this._planId})`;
            appointmentData[this._invitationStatusField] = STATUS.invitation.notSent;
            appointmentData[this._isPriorityField] = false;

            // Add account as a required attendee via activity party
            if (accountId) {
                appointmentData["appointment_activity_parties"] = [
                    {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        "partyid_account@odata.bind": `/accounts(${accountId})`,
                        participationtypemask: 5, // Required attendee
                    },
                ];
            }

            const created = await this._context.webAPI.createRecord("appointment", appointmentData);
            const newId = created.id.replace(/[{}]/g, "");

            // 2. Add the new visit to internal array
            this._visits.push({
                id: newId,
                subject: appointmentData.subject,
                scheduledStart: gapStart,
                scheduledEnd: gapEnd,
                location: accountAddress,
                accountName,
                accountId,
                address: accountAddress,
                lat: null,
                lng: null,
                geocodeError: false,
                driveSec: null,
                driveMeters: null,
                eta: null,
                opportunityId,
                opportunityName: null,
                isPriority: false,
                invitationStatus: 100000000,
                accountCity,
                estimatedValue: null,
                salesStage: null,
                estimatedCloseDate: null,
                ownerName: null,
                regardingType: opportunityId ? "opportunity" : null,
                actualstart: null,
            });

            // Sort visits by start time
            this._visits.sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());

            // 3. Remove picker panel
            pickerPanel.remove();

            // 4. Geocode new visit, recalculate route, re-render
            await this._geocodeAll();
            await this._calculateRoute();
            this._renderList();
            this._renderJourneySummary();
            this._renderMap();

            this._showMapBanner(
                `\u2705 Added "${this._escapeHtml(accountName)}" to the visit plan. Route recalculated.`, "info"
            );
        } catch (err) {
            console.error("[SVP] _addOpportunityToPlan error:", err);
            // Re-enable buttons
            pickerPanel.querySelectorAll(".svp-opp-add-btn").forEach((b) => {
                (b as HTMLButtonElement).disabled = false;
                b.textContent = "Add to plan";
            });
            this._showMapBanner("\u26A0\uFE0F Could not create appointment. " + String(err), "error");
        }
    }

    private _renderJourneySummary(): void {
        const visitCount = this._visits.length;
        const completedCount = this._visits.filter((v) => v.statecode === 1).length;

        if (this._legSummaries.length === 0 && visitCount > 0) {
            this._summaryEl.innerHTML =
                `${visitCount} visits` +
                (completedCount > 0 ? ` \u00A0\u00B7\u00A0 <span style="color:#107c10;font-weight:600">${completedCount} done</span>` : "");
            this._summaryEl.style.display = "";
            return;
        }

        if (this._legSummaries.length === 0) {
            this._summaryEl.style.display = "none";
            return;
        }

        const totalSec = this._legSummaries.reduce((s, l) => s + l.travelTimeSeconds, 0);

        const lastVisit = this._visits[this._visits.length - 1];
        const lastEnd = lastVisit?.scheduledEnd ?? lastVisit?.scheduledStart ?? new Date();
        const finishTime = lastEnd.toLocaleTimeString("en-GB", {
            hour: "2-digit", minute: "2-digit",
        });
        const lastEndMins = lastEnd.getHours() * 60 + lastEnd.getMinutes();
        const overruns = lastEndMins > this._workEndMins;
        const finishStyle = overruns ? ' style="color:#835E02;font-weight:600"' : '';

        this._summaryEl.innerHTML =
            `${visitCount} visits \u00A0\u00B7\u00A0 ${formatDuration(totalSec)} drive \u00A0\u00B7\u00A0 <span${finishStyle}>Est. finish ${finishTime}</span>` +
            (completedCount > 0 ? ` \u00A0\u00B7\u00A0 <span style="color:#107c10;font-weight:600">${completedCount} done</span>` : "");
        this._summaryEl.style.display = "";
    }

    /**
     * Returns the visual style (color + label) for a numbered visit marker
     * based on the visit's lifecycle state.
     *   completed  → gray with a check
     *   in-progress → green
     *   next active → bright orange (highlight current focus)
     *   default    → blue with the stop number
     */
    private _getVisitMarkerStyle(v: VisitItem, isNextActive: boolean): { color: string; text: string } {
        const idx = this._visits.indexOf(v);
        const num = String(idx >= 0 ? idx + 1 : "");
        if (v.statecode === 1) {
            return { color: "#a8a8a8", text: "\u2713" };
        }
        if (v.actualstart) {
            return { color: "#107c10", text: num };
        }
        if (isNextActive) {
            return { color: "#d83b01", text: num };
        }
        return { color: "#0078D4", text: num };
    }

    /**
     * Re-applies marker styles after a check-in/out without a full map rebuild.
     * Preserves the user's current zoom and pan.
     */
    private _refreshMapAfterStateChange(): void {
        if (!this._map || this._visitMarkers.size === 0) return;
        const nextActiveIdx = this._visits.findIndex((vv) => vv.statecode !== 1);
        this._visits.forEach((v, i) => {
            const marker = this._visitMarkers.get(v.id);
            if (!marker) return;
            const style = this._getVisitMarkerStyle(v, i === nextActiveIdx);
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (marker as any).setOptions({ color: style.color, text: style.text });
            } catch { /* noop */ }
        });
        // Recolor the route: legs leading up to the last completed stop go gray,
        // remaining legs stay blue.
        this._populateRouteSourceFromState();
    }

    /**
     * Splits this._routePoints into two LineString features and writes them to
     * this._routeSource:
     *   - "completed": from the start through the route point nearest to the
     *     last completed visit (gray)
     *   - "remaining": from that point to the end (blue)
     * If no visits are completed the whole route is "remaining".
     */
    private _populateRouteSourceFromState(): void {
        if (!this._routeSource || this._routePoints.length < 2) return;

        // Find the last completed visit that has coordinates.
        let lastCompletedIdx = -1;
        for (let i = this._visits.length - 1; i >= 0; i--) {
            const v = this._visits[i];
            if (v.statecode === 1 && v.lat !== null && v.lng !== null) {
                lastCompletedIdx = i;
                break;
            }
        }

        // Clear and rebuild
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ds: any = this._routeSource;
            if (typeof ds.clear === "function") ds.clear();
            else if (typeof ds.setShapes === "function") ds.setShapes([]);
        } catch { /* noop */ }

        if (lastCompletedIdx < 0) {
            // No completed visits — entire route is "remaining".
            this._routeSource.add(
                new atlas.data.Feature(
                    new atlas.data.LineString(this._routePoints),
                    { segment: "remaining" }
                )
            );
            return;
        }

        const lastCompleted = this._visits[lastCompletedIdx];
        const splitIdx = this._findNearestRoutePointIndex(
            lastCompleted.lng!,
            lastCompleted.lat!
        );

        // Guard against the split being at the very start/end.
        if (splitIdx <= 0) {
            this._routeSource.add(
                new atlas.data.Feature(
                    new atlas.data.LineString(this._routePoints),
                    { segment: "remaining" }
                )
            );
            return;
        }
        if (splitIdx >= this._routePoints.length - 1) {
            this._routeSource.add(
                new atlas.data.Feature(
                    new atlas.data.LineString(this._routePoints),
                    { segment: "completed" }
                )
            );
            return;
        }

        const completedPoints = this._routePoints.slice(0, splitIdx + 1);
        // Remaining starts at the split point so the two segments touch and
        // there is no visual gap.
        const remainingPoints = this._routePoints.slice(splitIdx);

        this._routeSource.add(
            new atlas.data.Feature(
                new atlas.data.LineString(completedPoints),
                { segment: "completed" }
            )
        );
        this._routeSource.add(
            new atlas.data.Feature(
                new atlas.data.LineString(remainingPoints),
                { segment: "remaining" }
            )
        );
    }

    /** Returns the index in _routePoints whose coordinate is closest to (lng,lat). */
    private _findNearestRoutePointIndex(lng: number, lat: number): number {
        let bestIdx = 0;
        let bestDistSq = Number.POSITIVE_INFINITY;
        for (let i = 0; i < this._routePoints.length; i++) {
            const [px, py] = this._routePoints[i];
            const dx = px - lng;
            const dy = py - lat;
            const d = dx * dx + dy * dy;
            if (d < bestDistSq) {
                bestDistSq = d;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    /* ───────────────── POST-VISIT NOTE MODAL ───────────────── */

    /**
     * Shows a modal asking the rep to capture a structured note about the
     * just-completed visit. On Save, creates an annotation on the linked
     * opportunity and patches the opportunity with any changed fields.
     * Dismissing (Skip / X) leaves everything unchanged.
     */
    private _showVisitNoteModal(v: VisitItem): void {
        if (!v.opportunityId) return;

        // Remove any prior modal (defensive)
        const existing = this._container.querySelector(".svp-vn-overlay");
        if (existing) existing.remove();

        const oppName = v.opportunityName ?? "Opportunity";
        const accountLabel = v.accountName ?? v.subject;
        const closeDateStr = v.estimatedCloseDate
            ? new Date(v.estimatedCloseDate).toISOString().slice(0, 10)
            : "";
        const estValStr = v.estimatedValue != null ? String(v.estimatedValue) : "";

        const overlay = document.createElement("div");
        overlay.className = "svp-vn-overlay";
        overlay.innerHTML =
            `<div class="svp-vn-dialog" role="dialog" aria-modal="true">` +
                `<div class="svp-vn-header">` +
                    `<div>` +
                        `<div class="svp-vn-title">Visit complete \u2014 ${this._escapeHtml(accountLabel)}</div>` +
                        `<div class="svp-vn-subtitle">Linked opportunity: ${this._escapeHtml(oppName)}</div>` +
                    `</div>` +
                    `<button class="svp-vn-close" type="button" aria-label="Close">\u2715</button>` +
                `</div>` +
                `<div class="svp-vn-body">` +
                    `<div class="svp-vn-row">` +
                        `<label class="svp-vn-label">Outcome</label>` +
                        `<select class="svp-vn-input" data-field="outcome">` +
                            `<option value="">\u2014</option>` +
                            `<option value="Positive">Positive</option>` +
                            `<option value="Neutral">Neutral</option>` +
                            `<option value="Negative">Negative</option>` +
                            `<option value="Need follow-up">Need follow-up</option>` +
                        `</select>` +
                    `</div>` +
                    `<div class="svp-vn-row">` +
                        `<label class="svp-vn-label">Next step</label>` +
                        `<select class="svp-vn-input" data-field="nextstep">` +
                            `<option value="">\u2014</option>` +
                            `<option value="Send proposal">Send proposal</option>` +
                            `<option value="Schedule follow-up">Schedule follow-up</option>` +
                            `<option value="Wait for customer">Wait for customer</option>` +
                            `<option value="Lost">Lost</option>` +
                        `</select>` +
                    `</div>` +
                    `<div class="svp-vn-row">` +
                        `<label class="svp-vn-label">Close date</label>` +
                        `<input class="svp-vn-input" type="date" data-field="closedate" value="${closeDateStr}" />` +
                    `</div>` +
                    `<div class="svp-vn-row">` +
                        `<label class="svp-vn-label">Estimated value (DKK)</label>` +
                        `<input class="svp-vn-input" type="number" min="0" step="1000" data-field="estvalue" value="${this._escapeHtml(estValStr)}" />` +
                    `</div>` +
                    `<div class="svp-vn-row svp-vn-row--full">` +
                        `<label class="svp-vn-label">Notes</label>` +
                        `<textarea class="svp-vn-input svp-vn-textarea" data-field="notes" rows="4" placeholder="What happened on the visit?"></textarea>` +
                    `</div>` +
                    `<div class="svp-vn-error" data-error hidden></div>` +
                `</div>` +
                `<div class="svp-vn-footer">` +
                    `<button class="svp-vn-btn svp-vn-btn-skip" type="button" data-action="skip">Skip</button>` +
                    `<button class="svp-vn-btn svp-vn-btn-save" type="button" data-action="save">Save &amp; close</button>` +
                `</div>` +
            `</div>`;

        this._container.appendChild(overlay);

        // Pre-select dropdown values (HTML escaping prevents using value=).
        const setSel = (field: string, val: string) => {
            const sel = overlay.querySelector<HTMLSelectElement>(`[data-field="${field}"]`);
            if (sel) sel.value = val;
        };
        setSel("outcome", "");
        setSel("nextstep", "");

        const close = () => overlay.remove();
        overlay.querySelector(".svp-vn-close")?.addEventListener("click", close);
        overlay.querySelector('[data-action="skip"]')?.addEventListener("click", close);

        const saveBtn = overlay.querySelector<HTMLButtonElement>('[data-action="save"]');
        const errorEl = overlay.querySelector<HTMLElement>("[data-error]");
        saveBtn?.addEventListener("click", () => {
            const get = (f: string): string => {
                const el = overlay.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-field="${f}"]`);
                return el ? (el.value || "").trim() : "";
            };
            const payload = {
                outcome: get("outcome"),
                nextstep: get("nextstep"),
                closedate: get("closedate"),
                estvalue: get("estvalue"),
                notes: get("notes"),
            };
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = "Saving\u2026";
            }
            if (errorEl) {
                errorEl.hidden = true;
                errorEl.textContent = "";
            }
            void this._saveVisitNote(v, payload)
                .then(() => {
                    close();
                    this._showMapBanner(`Note saved to ${oppName}`, "info");
                    setTimeout(() => this._showMapBanner("", "info"), 3500);
                    return null;
                })
                .catch((err) => {
                    console.error("[SVP] saveVisitNote failed", err);
                    if (errorEl) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        errorEl.textContent = `Could not save: ${(err as any)?.message ?? String(err)}`;
                        errorEl.hidden = false;
                    }
                    if (saveBtn) {
                        saveBtn.disabled = false;
                        saveBtn.textContent = "Save & close";
                    }
                });
        });
    }

    /**
     * Persists the visit-note form: creates an annotation on the opportunity
     * and patches changed fields on the opportunity itself.
     */
    private async _saveVisitNote(
        v: VisitItem,
        p: { outcome: string; nextstep: string; closedate: string; estvalue: string; notes: string }
    ): Promise<void> {
        if (!v.opportunityId || !this._context) return;
        const api = this._context.webAPI;

        // ── 1. Build & create the annotation (opportunity timeline note) ──
        const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        const lines: string[] = [`Visit on ${today} \u2014 ${v.accountName ?? v.subject}`];
        if (p.outcome) lines.push(`Outcome: ${p.outcome}`);
        if (p.nextstep) lines.push(`Next step: ${p.nextstep}`);
        if (p.closedate) lines.push(`Close date: ${p.closedate}`);
        if (p.estvalue) lines.push(`Estimated value: DKK ${Number(p.estvalue).toLocaleString("da-DK")}`);
        if (p.notes) lines.push("", p.notes);

        const note = {
            subject: `Visit completed \u2014 ${today}`,
            notetext: lines.join("\n"),
            "objectid_opportunity@odata.bind": `/opportunities(${v.opportunityId})`,
        };
        await api.createRecord("annotation", note);

        // ── 2. Patch opportunity with any changed fields ──
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const oppPatch: Record<string, any> = {};
        if (p.closedate) {
            const newCloseIso = new Date(p.closedate + "T00:00:00").toISOString();
            const currentIso = v.estimatedCloseDate
                ? new Date(v.estimatedCloseDate).toISOString()
                : "";
            if (newCloseIso !== currentIso) oppPatch["estimatedclosedate"] = newCloseIso;
        }
        if (p.estvalue) {
            const newVal = Number(p.estvalue);
            if (!Number.isNaN(newVal) && newVal !== v.estimatedValue) {
                oppPatch["estimatedvalue"] = newVal;
            }
        }
        if (Object.keys(oppPatch).length > 0) {
            await api.updateRecord("opportunity", v.opportunityId, oppPatch);
            // Reflect locally so the card shows the new values without a refetch.
            if (oppPatch["estimatedvalue"] != null) v.estimatedValue = oppPatch["estimatedvalue"];
            if (oppPatch["estimatedclosedate"]) v.estimatedCloseDate = oppPatch["estimatedclosedate"];
            this._renderList();
        }
    }

    /* ───────────────── WORKING HOURS ───────────────── */

    private async _fetchWorkingHours(context: ComponentFramework.Context<IInputs>): Promise<void> {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plan: any = await context.webAPI.retrieveRecord(
                this._planTable,
                this._planId,
                `?$select=${this._workDayStartField},${this._workDayEndField}`,
            );
            const resolveTime = (val: unknown, defaultHour: number): number => {
                if (!val) return defaultHour * 60;
                const d = new Date(val as string);
                return d.getHours() * 60 + d.getMinutes();
            };
            this._workStartMins = resolveTime(plan[this._workDayStartField], 8);
            this._workEndMins = resolveTime(plan[this._workDayEndField], 17);
            console.log(`[SVP] Working hours: ${this._fmtMins(this._workStartMins)}\u2013${this._fmtMins(this._workEndMins)}`);
        } catch (err) {
            console.warn("[SVP] Could not fetch working hours, using defaults:", err);
        }
    }

    private _fmtMins(totalMins: number): string {
        const h = Math.floor(totalMins / 60);
        const m = totalMins % 60;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }

    private _renderWorkingHoursRow(): void {
        const el = this._container.querySelector(".svp-working-hours-row") as HTMLDivElement | null;
        if (!el) return;
        el.innerHTML =
            `<span>Working hours: ${this._fmtMins(this._workStartMins)}\u2013${this._fmtMins(this._workEndMins)}</span>` +
            `<a class="svp-wh-edit" href="#">edit \u2197</a>`;
        el.style.display = "";
        el.querySelector(".svp-wh-edit")?.addEventListener("click", (e) => {
            e.preventDefault();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const xrm: any = (window as any).Xrm ?? (window as any).parent?.Xrm;
            xrm?.Navigation?.openForm?.({
                entityName: this._planTable,
                entityId: this._planId,
            });
        });
    }

    private _isOutsideWorkingHours(v: { scheduledStart: Date; scheduledEnd?: Date | null }): boolean {
        const startMins = v.scheduledStart.getHours() * 60 + v.scheduledStart.getMinutes();
        const end = v.scheduledEnd ?? v.scheduledStart;
        const endMins = end.getHours() * 60 + end.getMinutes();
        return startMins < this._workStartMins || endMins > this._workEndMins;
    }

    /* ───────────────── RENDER MAP (Azure Maps) ───────────────── */

    private _renderMap(): void {
        this._map = new atlas.Map(this._mapEl, {
            authOptions: {
                authType: atlas.AuthenticationType.subscriptionKey,
                subscriptionKey: this._azureMapsKey,
            },
            center: [-1.5, 52.5],
            zoom: 6,
            language: "en-US",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...({ style: "road" } as any),
        });

        // Log any map-level errors (e.g. auth failures, tile load errors)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this._map.events.add as any)("error", (e: any) => {
            console.error("[SVP] Azure Maps error event:", e);
            if (e?.error?.message?.toLowerCase().includes("unauthorized") ||
                e?.error?.message?.toLowerCase().includes("401")) {
                this._showMapBanner(
                    "⚠️ Azure Maps key is invalid or expired — map tiles cannot load.",
                    "error"
                );
            }
        });

        this._map.events.add("ready", () => {
            const map = this._map!;
            const coords: atlas.data.Position[] = [];

            // ── Draw route line FIRST (below markers) ──
            if (this._routePoints.length >= 2) {
                /* eslint-disable @typescript-eslint/no-explicit-any */
                const mapAny = map as any;

                // Clean up any prior route layers/sources
                try { mapAny.layers.remove("route-outline"); } catch { /* noop */ }
                try { mapAny.layers.remove("route-line"); } catch { /* noop */ }
                try { mapAny.sources.remove("route-source"); } catch { /* noop */ }

                const routeSource = new atlas.source.DataSource();
                map.sources.add(routeSource);
                this._routeSource = routeSource;

                // Build initial features (split into completed/remaining
                // segments based on current visit state).
                this._populateRouteSourceFromState();

                // White outline layer for road contrast
                const outlineLayer = new atlas.layer.LineLayer(routeSource, "route-outline", {
                    strokeColor: "#FFFFFF",
                    strokeWidth: 8,
                });
                (outlineLayer as any).setOptions({ lineJoin: "round", lineCap: "round", strokeOpacity: 0 });
                mapAny.layers.add(outlineLayer, "labels");

                // Single route line whose color depends on the segment property.
                // "completed" → gray, "remaining" → blue.
                const routeLine = new atlas.layer.LineLayer(routeSource, "route-line", {
                    strokeWidth: 5,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    strokeColor: [
                        "case",
                        ["==", ["get", "segment"], "completed"], "#a8a8a8",
                        "#0078D4",
                    ] as any,
                });
                (routeLine as any).setOptions({ lineJoin: "round", lineCap: "round", strokeOpacity: 0 });
                mapAny.layers.add(routeLine, "labels");

                // Animated fade-in
                let opacity = 0;
                const fadeIn = setInterval(() => {
                    opacity += 0.1;
                    try {
                        (outlineLayer as any).setOptions({ strokeOpacity: Math.min(opacity, 1) });
                        (routeLine as any).setOptions({ strokeOpacity: Math.min(opacity, 1) });
                    } catch { /* noop */ }
                    if (opacity >= 1) clearInterval(fadeIn);
                }, 60);
                /* eslint-enable @typescript-eslint/no-explicit-any */

                // Turn markers from guidance instructions
                this._addTurnMarkers(map);

            } else if (this._visits.filter((v) => v.lat !== null).length >= 2) {
                // Fallback: straight dashed polyline if route API failed
                const fallbackCoords = this._visits
                    .filter((v) => v.lat !== null && v.lng !== null)
                    .map((v) => [v.lng!, v.lat!] as atlas.data.Position);
                if (fallbackCoords.length >= 2) {
                    const ds = new atlas.source.DataSource();
                    map.sources.add(ds);
                    ds.add(new atlas.data.Feature(new atlas.data.LineString(fallbackCoords)));
                    map.layers.add(
                        new atlas.layer.LineLayer(ds, null, {
                            strokeColor: "#0078D4",
                            strokeWidth: 3,
                            strokeDashArray: [4, 4],
                        })
                    );
                }
            }

            // ── "Your location" start marker ──
            if (this._currentPosition) {
                const startMarker = new atlas.HtmlMarker({
                    position: this._currentPosition,
                    color: "#107C10",
                    text: "\uD83D\uDCCD",
                });
                map.markers.add(startMarker);
                coords.push(this._currentPosition);
            }

            // ── Numbered appointment markers ──
            this._visitMarkers.clear();
            // Find the index of the next "active" stop (first not-yet-completed
            // visit) so we can highlight it.
            const nextActiveIdx = this._visits.findIndex((vv) => vv.statecode !== 1);
            this._visits.forEach((v, i) => {
                if (v.lat === null || v.lng === null) return;

                const position: atlas.data.Position = [v.lng, v.lat];
                coords.push(position);

                const style = this._getVisitMarkerStyle(v, i === nextActiveIdx);
                const marker = new atlas.HtmlMarker({
                    position,
                    text: style.text,
                    color: style.color,
                });
                map.markers.add(marker);
                this._visitMarkers.set(v.id, marker);
            });

            // ── Info message for single-pin scenario ──
            const geocodedCount = this._visits.filter((v) => v.lat !== null).length;
            if (geocodedCount === 1 && this._routePoints.length === 0 && !this._currentPosition) {
                this._showMapBanner(
                    "\u2139\uFE0F Add valid account addresses to see the driving route.",
                    "info"
                );
            }

            // Fit bounds to all markers
            if (coords.length > 0) {
                map.setCamera({
                    bounds: atlas.data.BoundingBox.fromPositions(coords),
                    padding: 50,
                });
            }
        });
    }

    private _addTurnMarkers(_map: atlas.Map): void {
        // Turn markers are not available with the v2025-01-01 Route API.
        // This method is retained as a no-op for future use.
    }

    /* ───────────────── ROUTE OPTIMIZATION ───────────────── */

    private _wireOptimizeButton(): void {
        let btn = this._container.querySelector<HTMLButtonElement>("#svp-optimize-btn");
        if (!btn) return;
        // Clear any previously attached listeners by cloning the node.
        // _wireOptimizeButton() is invoked from multiple lifecycle points
        // (initial render, after optimize completes, on re-render). Without
        // this, click listeners accumulate and a single click opens the
        // optimization dialog N times.
        const fresh = btn.cloneNode(true) as HTMLButtonElement;
        btn.replaceWith(fresh);
        btn = fresh;
        this._optimizeBtn = btn;
        btn.addEventListener("click", async () => {
            if (this._isOptimizing) return;
            this._setActiveMode("optimize");

            // ── Deduplicate by accountId (keep earliest scheduledStart) ──
            let geocoded = this._visits.filter((v) => v.lat !== null && v.lng !== null);
            const seenAccounts = new Map<string, VisitItem>();
            let dedupCount = 0;
            const deduped: VisitItem[] = [];
            for (const v of geocoded) {
                const key = v.accountId ?? v.id; // use accountId if available, else visit id
                const existing = seenAccounts.get(key);
                if (existing) {
                    dedupCount++;
                    // Keep earliest scheduledStart
                    if (v.scheduledStart < existing.scheduledStart) {
                        // Replace the existing entry
                        const idx = deduped.indexOf(existing);
                        if (idx >= 0) deduped[idx] = v;
                        seenAccounts.set(key, v);
                    }
                } else {
                    seenAccounts.set(key, v);
                    deduped.push(v);
                }
            }
            geocoded = deduped;

            if (geocoded.length < 2) {
                this._showMapBanner("Need at least 2 geocoded visits to optimize.", "warning");
                this._setActiveMode("plan");
                return;
            }

            if (dedupCount > 0) {
                console.log(`[SVP] Removed ${dedupCount} duplicate stop(s) before optimization`);
            }

            // ── Step 1: Fetch plan visit date and start time ──
            const context = this._context;
            if (!context) return;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let plan: any;
            try {
                plan = await context.webAPI.retrieveRecord(
                    this._planTable,
                    this._planId,
                    `?$select=${this._workDayStartField}`
                );
            } catch (err) {
                console.error("Failed to fetch plan:", err);
                this._showMapBanner("Could not fetch plan details.", "error");
                this._setActiveMode("plan");
                return;
            }

            const rawStartTime = plan[this._workDayStartField] ?? null;
            if (!rawStartTime) {
                this._showMapBanner(
                    "Please set a Visit Date & Start Time on the Sales Visit Plan before calculating the route.",
                    "warning"
                );
                this._setActiveMode("plan");
                return;
            }

            const baseStart = new Date(rawStartTime as string);
            this._isOptimizing = true;
            this._setOptimizeButtonState("loading");

            try {
                const coordinates: [number, number][] = geocoded.map((v) => [v.lng!, v.lat!]);
                const matrix = await this._getRouteMatrix(coordinates);
                const currentTotal = this._calculateCurrentTotal(matrix, coordinates.length);
                const { optimizedIndices, totalSeconds } = this._optimizeOrder(matrix, coordinates.length);
                const optimizedVisits = optimizedIndices.map((i) => geocoded[i]);

                this._showOptimizationDialog(
                    geocoded,
                    optimizedVisits,
                    currentTotal,
                    totalSeconds,
                    async (finalOrder: VisitItem[]) => {
                        // ── Apply the final order (may have been manually adjusted) ──
                        this._showMapBanner("Updating appointments...", "info");

                        this._preOptimizationOrder = [...this._visits];
                        const nonGeocoded = this._visits.filter((v) => v.lat === null || v.lng === null);
                        this._visits = [...finalOrder, ...nonGeocoded];
                        this._routePoints = [];
                        this._legSummaries = [];
                        await this._calculateRoute();

                        // ── Calculate sequential times from work day start ──
                        const wsH = Math.floor(this._workStartMins / 60);
                        const wsM = this._workStartMins % 60;
                        const refDate = finalOrder.length > 0 ? new Date(finalOrder[0].scheduledStart) : new Date();
                        let currentTime = new Date(refDate);
                        currentTime.setHours(wsH, wsM, 0, 0);

                        const updatedAppointments: {
                            activityid: string;
                            scheduledstart: string;
                            scheduledend: string;
                            visitorder: number;
                        }[] = [];

                        for (let i = 0; i < finalOrder.length; i++) {
                            const visit = finalOrder[i];
                            const origStart = visit.scheduledStart;
                            const origEnd = visit.scheduledEnd ?? origStart;
                            const durationMs = (origEnd.getTime() - origStart.getTime()) || (60 * 60 * 1000);

                            const visitStart = new Date(currentTime);
                            const visitEnd = new Date(currentTime.getTime() + durationMs);

                            updatedAppointments.push({
                                activityid: visit.id,
                                scheduledstart: visitStart.toISOString(),
                                scheduledend: visitEnd.toISOString(),
                                visitorder: i + 1,
                            });

                            visit.scheduledStart = visitStart;
                            visit.scheduledEnd = visitEnd;

                            if (i < finalOrder.length - 1) {
                                const fromIdx = geocoded.indexOf(finalOrder[i]);
                                const toIdx = geocoded.indexOf(finalOrder[i + 1]);
                                const travelSeconds = (fromIdx >= 0 && toIdx >= 0) ? (matrix[fromIdx]?.[toIdx] ?? 0) : 0;

                                currentTime = new Date(visitEnd.getTime() + (travelSeconds * 1000));
                            }
                        }

                        // ── Leg summaries ──
                        this._optimizedLegSummaries = [];
                        for (let i = 0; i < finalOrder.length - 1; i++) {
                            const fromIdx = geocoded.indexOf(finalOrder[i]);
                            const toIdx = geocoded.indexOf(finalOrder[i + 1]);
                            const secs = (fromIdx >= 0 && toIdx >= 0) ? (matrix[fromIdx]?.[toIdx] ?? 0) : 0;
                            this._optimizedLegSummaries.push({
                                travelTimeSeconds: secs,
                                travelTimeFormatted: formatDuration(secs),
                            });
                        }

                        // ── Save to D365 ──
                        this._showMapBanner(`Updating ${updatedAppointments.length} appointments...`, "info");

                        try {
                            const visitOrderField = await this._getFieldName(
                                this._visitOrderField, "vis_new_visitorder", "vis_visitorder", "new_visitorder"
                            );

                            await Promise.all(
                                updatedAppointments.map(async (appt) => {
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    const updateData: any = {
                                        scheduledstart: appt.scheduledstart,
                                        scheduledend: appt.scheduledend,
                                    };
                                    updateData[visitOrderField] = appt.visitorder;
                                    await context.webAPI.updateRecord("appointment", appt.activityid, updateData);
                                })
                            );
                        } catch (err) {
                            console.error("Failed to save times:", err);
                            this._showMapBanner("Route calculated but could not save appointment times.", "error");
                            return;
                        }

                        // ── Update plan record ──
                        let totalTravelSeconds = 0;
                        for (let i = 0; i < finalOrder.length - 1; i++) {
                            const fromIdx = geocoded.indexOf(finalOrder[i]);
                            const toIdx = geocoded.indexOf(finalOrder[i + 1]);
                            totalTravelSeconds += (fromIdx >= 0 && toIdx >= 0) ? (matrix[fromIdx]?.[toIdx] ?? 0) : 0;
                        }
                        const totalDriveMinutes = Math.round(totalTravelSeconds / 60);

                        try {
                            const planUpdate: Record<string, unknown> = {};
                            planUpdate[this._planStatusField] = STATUS.plan.active;
                            planUpdate[this._driveMinutesField] = totalDriveMinutes;
                            await context.webAPI.updateRecord(this._planTable, this._planId, planUpdate);
                        } catch (err) {
                            console.error("Failed to update plan:", err);
                        }

                        // ── Re-render ──
                        this._renderList();
                        this._renderJourneySummary();
                        if (this._map) { this._map.dispose(); this._map = null; }
                        this._renderMap();
                        this._wireOptimizeButton();

                        const firstStart = new Date(updatedAppointments[0].scheduledstart);
                        const lastEnd = new Date(updatedAppointments[updatedAppointments.length - 1].scheduledend);

                        this._summaryEl.innerHTML =
                            `${updatedAppointments.length} visits \u00A0\u00B7\u00A0 ${formatDuration(totalTravelSeconds)} drive \u00A0\u00B7\u00A0 Est. finish ${lastEnd.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
                        this._summaryEl.style.display = "";

                        this._mapBanner.innerHTML = "";
                        this._showUndoBar(
                            `Route optimized \u2014 ${updatedAppointments.length} visits updated`
                        );

                        // Reset optimize state after apply
                        this._isOptimizing = false;
                        this._setOptimizeButtonState("ready");
                        this._setActiveMode("plan");
                    },
                    () => {
                        // cancelled — reset optimize state
                        this._isOptimizing = false;
                        this._setOptimizeButtonState("ready");
                        this._setActiveMode("plan");
                    },
                    matrix,
                    geocoded,
                );
            } catch (err) {
                console.error("[SVP] Optimization failed:", err);
                this._showMapBanner("Could not optimize route. Please try again.", "error");
                this._isOptimizing = false;
                this._setOptimizeButtonState("ready");
                this._setActiveMode("plan");
            }
        });
    }

    private async _getRouteMatrix(coordinates: [number, number][]): Promise<number[][]> {
        const requestBody = {
            origins: { type: "MultiPoint", coordinates },
            destinations: { type: "MultiPoint", coordinates },
        };

        const url =
            `https://atlas.microsoft.com/route/matrix/sync/json` +
            `?api-version=1.0` +
            `&subscription-key=${this._azureMapsKey}` +
            `&travelMode=car` +
            `&routeType=shortest`;

        console.log("[SVP] Matrix API request:", JSON.stringify(requestBody));
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const error = await response.text();
            console.error("[SVP] Matrix API error:", response.status, error);
            throw new Error(`Matrix API failed: ${response.status}`);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await response.json();
        console.log("[SVP] Matrix API response received");

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const matrix: number[][] = data.matrix.map((row: any[]) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            row.map((cell: any) => cell.response?.routeSummary?.travelTimeInSeconds ?? 99999)
        );
        return matrix;
    }

    private _optimizeOrder(
        matrix: number[][],
        n: number
    ): { optimizedIndices: number[]; totalSeconds: number } {
        const visited = new Array(n).fill(false) as boolean[];
        const order: number[] = [];
        let totalSeconds = 0;

        // Start from the stop with the lowest total outbound travel time
        let startIndex = 0;
        let lowestTotal = Infinity;
        for (let i = 0; i < n; i++) {
            const total = matrix[i].reduce((sum, t) => sum + t, 0);
            if (total < lowestTotal) {
                lowestTotal = total;
                startIndex = i;
            }
        }

        let current = startIndex;
        order.push(current);
        visited[current] = true;

        for (let step = 1; step < n; step++) {
            let nearestIndex = -1;
            let nearestTime = Infinity;
            for (let j = 0; j < n; j++) {
                if (!visited[j] && matrix[current][j] < nearestTime) {
                    nearestTime = matrix[current][j];
                    nearestIndex = j;
                }
            }
            if (nearestIndex === -1) break;
            totalSeconds += matrix[current][nearestIndex];
            order.push(nearestIndex);
            visited[nearestIndex] = true;
            current = nearestIndex;
        }

        return { optimizedIndices: order, totalSeconds };
    }

    private _calculateCurrentTotal(matrix: number[][], n: number): number {
        let total = 0;
        for (let i = 0; i < n - 1; i++) {
            total += matrix[i][i + 1];
        }
        return total;
    }

    private _showOptimizationDialog(
        currentOrder: VisitItem[],
        optimizedOrder: VisitItem[],
        currentSeconds: number,
        optimizedSeconds: number,
        onConfirm: (finalOrder: VisitItem[]) => void,
        onCancel: () => void,
        matrix: number[][],
        geocodedRef: VisitItem[],
    ): void {
        // ── State ──
        let optList = [...optimizedOrder];
        const locked = new Set<string>(); // visit IDs that are locked
        let optSeconds = optimizedSeconds;
        let manuallyAdjusted = false;
        let dragIdx: number | null = null;
        let previewActive = false;
        type OptMode = "time" | "priority" | "balanced";
        let mode: OptMode = "time";

        // ── Rescheduled times from work day start ──
        interface RescheduleEntry { start: Date; end: Date; durationMins: number; driveToNextMins: number; }
        let rescheduleMap: RescheduleEntry[] = [];

        const computeReschedule = (): void => {
            rescheduleMap = [];
            const wsH = Math.floor(this._workStartMins / 60);
            const wsM = this._workStartMins % 60;

            // Use date from first visit or today
            const refDate = optList.length > 0 ? new Date(optList[0].scheduledStart) : new Date();
            let cursor = new Date(refDate);
            cursor.setHours(wsH, wsM, 0, 0);

            for (let i = 0; i < optList.length; i++) {
                const v = optList[i];
                const origStart = v.scheduledStart;
                const origEnd = v.scheduledEnd ?? origStart;
                const durationMins = Math.round((origEnd.getTime() - origStart.getTime()) / 60000) || 60;

                const start = new Date(cursor);
                const end = new Date(cursor);
                end.setMinutes(end.getMinutes() + durationMins);

                let driveToNextMins = 0;
                if (i < optList.length - 1) {
                    const fromIdx = geocodedRef.indexOf(optList[i]);
                    const toIdx = geocodedRef.indexOf(optList[i + 1]);
                    const secs = (fromIdx >= 0 && toIdx >= 0) ? (matrix[fromIdx]?.[toIdx] ?? 0) : 0;
                    driveToNextMins = Math.ceil(secs / 60);
                }

                rescheduleMap.push({ start, end, durationMins, driveToNextMins });

                // Advance cursor: end + drive to next
                cursor = new Date(end);
                if (i < optList.length - 1) {
                    cursor.setMinutes(cursor.getMinutes() + driveToNextMins);
                }
            }
        };

        const getOverrunMins = (): number => {
            if (rescheduleMap.length === 0) return 0;
            const last = rescheduleMap[rescheduleMap.length - 1];
            const lastEndMins = last.end.getHours() * 60 + last.end.getMinutes();
            return Math.max(0, lastEndMins - this._workEndMins);
        };

        const fmtTimeDate = (d: Date): string =>
            d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

        // Initial reschedule
        computeReschedule();

        // ── SVG padlock icons (Fluent-style, 16×16) ──
        const SVG_LOCK_OPEN = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="7" width="10" height="7" rx="1" stroke="#c8c6c4" stroke-width="1.2"/><path d="M5 7V5a3 3 0 0 1 6 0" stroke="#c8c6c4" stroke-width="1.2" stroke-linecap="round"/></svg>`;
        const SVG_LOCK_CLOSED = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="7" width="10" height="7" rx="1" stroke="#0078d4" stroke-width="1.2"/><path d="M5 7V5a3 3 0 0 1 6 0V7" stroke="#0078d4" stroke-width="1.2" stroke-linecap="round"/></svg>`;

        // ── Priority scoring ──
        const computeScore = (v: VisitItem): number => {
            let score = 0;
            if (v.isPriority) score += 100; else score += 10;
            const val = v.estimatedValue ?? 0;
            score += Math.min(val / 100000, 50);
            if (v.estimatedCloseDate) {
                const days = Math.max(0, (new Date(v.estimatedCloseDate).getTime() - Date.now()) / 86400000);
                if (days <= 7) score += 40;
                else if (days <= 14) score += 25;
                else if (days <= 30) score += 10;
            }
            return Math.round(score);
        };

        const optimizeByPriority = (stops: VisitItem[]): VisitItem[] => {
            const lockedPos: { idx: number; visit: VisitItem }[] = [];
            const unlocked: VisitItem[] = [];
            stops.forEach((v, i) => {
                if (locked.has(v.id)) lockedPos.push({ idx: i, visit: v });
                else unlocked.push(v);
            });
            const scored = unlocked.map(v => ({ v, score: computeScore(v) }));
            scored.sort((a, b) => b.score - a.score);
            const result: VisitItem[] = [];
            let uIdx = 0;
            for (let i = 0; i < stops.length; i++) {
                const lp = lockedPos.find(l => l.idx === i);
                if (lp) result.push(lp.visit);
                else if (uIdx < scored.length) result.push(scored[uIdx++].v);
            }
            return result;
        };

        const optimizeBalanced = (stops: VisitItem[]): VisitItem[] => {
            const timeOpt = this._optimizeWithLocks(stops, locked, matrix, geocodedRef);
            const total = timeOpt.length;
            const lockedPos: { idx: number; visit: VisitItem }[] = [];
            const unlocked: { v: VisitItem; balanced: number; idx: number }[] = [];
            timeOpt.forEach((v, i) => {
                if (locked.has(v.id)) lockedPos.push({ idx: i, visit: v });
                else {
                    const timeScore = (1 - i / total) * 60;
                    const prioScore = (computeScore(v) / 200) * 40;
                    unlocked.push({ v, balanced: timeScore + prioScore, idx: i });
                }
            });
            unlocked.sort((a, b) => b.balanced - a.balanced);
            const result: VisitItem[] = [];
            let uIdx = 0;
            for (let i = 0; i < stops.length; i++) {
                const lp = lockedPos.find(l => l.idx === i);
                if (lp) result.push(lp.visit);
                else if (uIdx < unlocked.length) result.push(unlocked[uIdx++].v);
            }
            return result;
        };

        const reoptForMode = () => {
            if (mode === "time") optList = this._optimizeWithLocks(optList, locked, matrix, geocodedRef);
            else if (mode === "priority") optList = optimizeByPriority(optList);
            else optList = optimizeBalanced(optList);
            recalcOptTime();
            computeReschedule();
        };

        const timeSaved = () => currentSeconds - optSeconds;
        const fmtTime = (v: VisitItem) => {
            const s = v.scheduledStart;
            const e = v.scheduledEnd;
            if (!s) return "";
            const sf = s.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
            const ef = e ? e.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
            return ef ? `${sf}\u2009\u2013\u2009${ef}` : sf;
        };
        const fmtAddr = (v: VisitItem) => v.address ?? v.accountCity ?? "";

        // ── Recalculate optimized travel time from matrix ──
        const recalcOptTime = () => {
            let total = 0;
            for (let i = 0; i < optList.length - 1; i++) {
                const fromIdx = geocodedRef.indexOf(optList[i]);
                const toIdx = geocodedRef.indexOf(optList[i + 1]);
                if (fromIdx >= 0 && toIdx >= 0) total += matrix[fromIdx]?.[toIdx] ?? 0;
            }
            optSeconds = total;
        };

        // ── Build a row for a stop ──
        const buildRow = (v: VisitItem, i: number, isOpt: boolean): string => {
            const isLocked = locked.has(v.id);
            const draggable = isOpt && !isLocked;
            const badgeCls = isOpt ? " svp-optdlg-badge-opt" : "";
            const lockedCls = isLocked ? " svp-optdlg-item-locked" : "";
            const lockSvg = isLocked ? SVG_LOCK_CLOSED : SVG_LOCK_OPEN;
            const lockTitle = isLocked
                ? "Stop is locked. Click to unlock."
                : "Click to lock this stop in place. It won\u2019t move if you re-optimize.";
            const lockCls = isLocked ? " svp-optdlg-lock-on" : "";
            const showScore = isOpt && mode !== "time";
            const scoreCell = showScore
                ? `<span class="svp-optdlg-score-pill">Score: ${computeScore(v)}</span>`
                : `<span></span>`;
            const addrLine = isOpt ? `<span class="svp-optdlg-addr">${this._escapeHtml(fmtAddr(v))}</span>` : "";
            const gridCls = isOpt ? " svp-optdlg-item-opt" : " svp-optdlg-item-cur";

            if (isOpt) {
                // Show rescheduled times from work day start
                const rsEntry = rescheduleMap[i];
                const rsTime = rsEntry
                    ? `${fmtTimeDate(rsEntry.start)}\u2009\u2013\u2009${fmtTimeDate(rsEntry.end)}`
                    : fmtTime(v);
                return `<li class="svp-optdlg-item${gridCls}${lockedCls}" data-idx="${i}" ${draggable ? `draggable="true"` : ""}>` +
                    `<span class="svp-optdlg-drag">\u2807</span>` +
                    `<span class="svp-optdlg-badge${badgeCls}">${i + 1}</span>` +
                    `<div class="svp-optdlg-stop-info">` +
                    `<span class="svp-optdlg-name">${this._escapeHtml(v.accountName ?? v.subject)}</span>` +
                    addrLine +
                    `</div>` +
                    `<span class="svp-optdlg-time-range">${rsTime}</span>` +
                    scoreCell +
                    `<button class="svp-optdlg-lock${lockCls}" data-lock-idx="${i}" title="${lockTitle}">${lockSvg}</button>` +
                    `</li>`;
            }
            // Current order row: badge | info | time
            return `<li class="svp-optdlg-item${gridCls}" data-idx="${i}">` +
                `<span class="svp-optdlg-badge${badgeCls}">${i + 1}</span>` +
                `<div class="svp-optdlg-stop-info">` +
                `<span class="svp-optdlg-name">${this._escapeHtml(v.accountName ?? v.subject)}</span>` +
                `</div>` +
                `<span class="svp-optdlg-time-range">${fmtTime(v)}</span>` +
                `</li>`;
        };

        const buildList = (items: VisitItem[], isOpt: boolean): string =>
            items.map((v, i) => buildRow(v, i, isOpt)).join("");

        // ── Create dialog ──
        const dialog = document.createElement("div");
        dialog.className = "svp-optdlg-overlay";

        const renderDialog = () => {
            const saved = timeSaved();
            const highPrioCount = optList.filter(v => v.isPriority).length;

            let savingText: string;
            let savingCls: string;

            // Finish time from reschedule
            const overrun = getOverrunMins();
            const finishTime = rescheduleMap.length > 0
                ? fmtTimeDate(rescheduleMap[rescheduleMap.length - 1].end)
                : "";

            if (mode === "time") {
                const timeParts: string[] = [];
                if (saved > 0) timeParts.push(`Save ${formatDuration(saved)}`);
                if (finishTime) timeParts.push(`Day finishes at ${finishTime}`);
                if (overrun > 0) {
                    savingText = timeParts.length > 0 ? timeParts.join(" \u00B7 ") : "Your current route is already optimal";
                    savingCls = "svp-optdlg-saving-warn";
                } else {
                    savingText = timeParts.length > 0 ? timeParts.join(" \u00B7 ") : "Your current route is already optimal";
                    savingCls = saved > 0 ? "svp-optdlg-saving-pos" : "svp-optdlg-saving-neutral";
                }
            } else if (mode === "priority") {
                const prioParts: string[] = [];
                if (highPrioCount > 0) prioParts.push(`${highPrioCount} high-priority visit${highPrioCount !== 1 ? "s" : ""} scheduled first`);
                if (finishTime) prioParts.push(`Finishes at ${finishTime}`);
                savingText = prioParts.length > 0 ? prioParts.join(" \u00B7 ") : "No high-priority visits found";
                savingCls = overrun > 0 ? "svp-optdlg-saving-warn" : (highPrioCount > 0 ? "svp-optdlg-saving-pos" : "svp-optdlg-saving-neutral");
            } else {
                const parts: string[] = [];
                if (saved > 0) parts.push(`Save ${formatDuration(saved)}`);
                if (highPrioCount > 0) parts.push(`${highPrioCount} high-priority visit${highPrioCount !== 1 ? "s" : ""} first`);
                if (finishTime) parts.push(`Finishes at ${finishTime}`);
                savingText = parts.length > 0 ? parts.join(" \u00B7 ") : "Balanced optimization applied";
                savingCls = overrun > 0 ? "svp-optdlg-saving-warn" : (parts.length > 0 ? "svp-optdlg-saving-pos" : "svp-optdlg-saving-neutral");
            }

            // Overrun warning message
            const overrunHtml = overrun > 0
                ? `<div class="svp-optdlg-overrun-warn">\u26A0 Plan finishes at ${finishTime} \u2014 ${overrun}\u2009min after work day end (${this._fmtMins(this._workEndMins)}). Consider removing a stop or extending your work day.</div>`
                : "";

            const modeDescriptions: Record<OptMode, string> = {
                time: "Shortest total drive time \u2014 reorders stops geographically",
                priority: "High-value and urgent opportunities first \u2014 route may be less efficient",
                balanced: "Balances 60\u2009% drive efficiency with 40\u2009% opportunity priority",
            };
            dialog.innerHTML = `
            <div class="svp-optdlg">
                <div class="svp-optdlg-header">
                    <span>Route optimization</span>
                    <button class="svp-optdlg-close">\u2715</button>
                </div>
                <div class="svp-optdlg-saving ${savingCls}">
                    ${this._escapeHtml(savingText)}
                    ${manuallyAdjusted ? `<div class="svp-optdlg-saving-manual">Manually adjusted</div>` : ""}
                </div>
                ${overrunHtml}
                <div class="svp-optdlg-mode-bar">
                    <div class="svp-optdlg-mode-group">
                        <button class="svp-optdlg-mode-btn${mode === "time" ? " svp-optdlg-mode-btn-active" : ""}" data-mode="time">Optimize by time</button>
                        <button class="svp-optdlg-mode-btn${mode === "priority" ? " svp-optdlg-mode-btn-active" : ""}" data-mode="priority">By priority</button>
                        <button class="svp-optdlg-mode-btn${mode === "balanced" ? " svp-optdlg-mode-btn-active" : ""}" data-mode="balanced">Balanced</button>
                    </div>
                </div>
                <div class="svp-optdlg-mode-desc">${modeDescriptions[mode]}</div>
                <div class="svp-optdlg-lock-hint">${SVG_LOCK_CLOSED} Click the lock on any stop in the optimized list to keep it in place</div>
                <div class="svp-optdlg-hdrs">
                    <div class="svp-optdlg-hdr-cell">
                        <div class="svp-optdlg-hdr-label">Current order</div>
                        <div class="svp-optdlg-hdr-time"><span class="svp-optdlg-hdr-time-label">Total drive time:</span> ${formatDuration(currentSeconds)}</div>
                        <div class="svp-optdlg-colhdr svp-optdlg-colhdr-current"><span>#</span><span>Account</span><span>Time</span></div>
                    </div>
                    <div class="svp-optdlg-hdr-divider"></div>
                    <div class="svp-optdlg-hdr-cell">
                        <div class="svp-optdlg-hdr-label">Optimized order</div>
                        <div class="svp-optdlg-hdr-time svp-optdlg-hdr-time-opt"><span class="svp-optdlg-hdr-time-label">Total drive time:</span> ${formatDuration(optSeconds)}</div>
                        <div class="svp-optdlg-colhdr svp-optdlg-colhdr-opt"><span></span><span>#</span><span>Account</span><span>Time</span><span>Score</span><span></span></div>
                    </div>
                </div>
                <div class="svp-optdlg-lists">
                    <div class="svp-optdlg-list-pane svp-optdlg-list-pane-current" data-pane="current">
                        <ol class="svp-optdlg-list svp-optdlg-list-current">${buildList(currentOrder, false)}</ol>
                    </div>
                    <div class="svp-optdlg-list-divider"></div>
                    <div class="svp-optdlg-list-pane svp-optdlg-list-pane-opt" data-pane="opt">
                        <ol class="svp-optdlg-list svp-optdlg-list-opt">${buildList(optList, true)}</ol>
                        <div class="svp-optdlg-reschedule-note">Times recalculated from work day start (${this._fmtMins(this._workStartMins)})</div>
                        ${locked.size > 0 ? `<button class="svp-optdlg-reopt-btn">Re-optimize unlocked stops</button>` : ""}
                    </div>
                </div>
                <div class="svp-optdlg-actions">
                    <div class="svp-optdlg-actions-left">
                        <button class="svp-optdlg-preview-btn">${previewActive ? "Hide preview" : "Preview on map"}</button>
                    </div>
                    <div class="svp-optdlg-actions-right">
                        <button class="svp-optdlg-cancel-btn">Cancel</button>
                        <button class="svp-optdlg-confirm-btn">Apply</button>
                    </div>
                </div>
            </div>`;

            wireEvents();
        };

        // ── Wire all interactive events ──
        const wireEvents = () => {
            // Close / Cancel
            dialog.querySelector(".svp-optdlg-close")?.addEventListener("click", () => { cleanup(); onCancel(); });
            dialog.querySelector(".svp-optdlg-cancel-btn")?.addEventListener("click", () => { cleanup(); onCancel(); });

            // Mode toggle
            dialog.querySelectorAll(".svp-optdlg-mode-btn").forEach(btn => {
                btn.addEventListener("click", () => {
                    const newMode = (btn as HTMLElement).dataset.mode as OptMode;
                    if (newMode === mode) return;
                    mode = newMode;
                    manuallyAdjusted = false;
                    reoptForMode();
                    renderDialog();
                    if (previewActive) this._showDualRoutePreview(currentOrder, optList);
                });
            });

            // Apply
            dialog.querySelector(".svp-optdlg-confirm-btn")?.addEventListener("click", () => {
                console.log("[SVP] Apply clicked. Rescheduled stops:", rescheduleMap.map((r, i) => ({
                    name: optList[i]?.accountName ?? optList[i]?.subject,
                    start: r.start.toISOString(),
                    end: r.end.toISOString(),
                })));
                cleanup();
                onConfirm(optList);
            });

            // Preview toggle
            dialog.querySelector(".svp-optdlg-preview-btn")?.addEventListener("click", () => {
                previewActive = !previewActive;
                if (previewActive) {
                    this._showDualRoutePreview(currentOrder, optList);
                } else {
                    this._removeDualRoutePreview();
                }
                renderDialog();
            });

            // Re-optimize unlocked
            dialog.querySelector(".svp-optdlg-reopt-btn")?.addEventListener("click", () => {
                reoptForMode();
                manuallyAdjusted = false;
                renderDialog();
                if (previewActive) this._showDualRoutePreview(currentOrder, optList);
            });

            // Lock toggles
            dialog.querySelectorAll(".svp-optdlg-lock").forEach((btn) => {
                btn.addEventListener("click", () => {
                    const idx = parseInt((btn as HTMLElement).dataset.lockIdx ?? "-1", 10);
                    if (idx < 0 || idx >= optList.length) return;
                    const vid = optList[idx].id;
                    if (locked.has(vid)) locked.delete(vid);
                    else locked.add(vid);
                    renderDialog();
                });
            });

            // Drag and drop on optimized list
            const optItems = dialog.querySelectorAll(".svp-optdlg-list-opt .svp-optdlg-item[draggable]");
            optItems.forEach((el) => {
                el.addEventListener("dragstart", (e) => {
                    dragIdx = parseInt((el as HTMLElement).dataset.idx ?? "-1", 10);
                    (el as HTMLElement).classList.add("svp-optdlg-item-dragging");
                    (e as DragEvent).dataTransfer?.setData("text/plain", String(dragIdx));
                });
                el.addEventListener("dragend", () => {
                    (el as HTMLElement).classList.remove("svp-optdlg-item-dragging");
                    dialog.querySelectorAll(".svp-optdlg-item-dragover").forEach((o) => o.classList.remove("svp-optdlg-item-dragover"));
                    dragIdx = null;
                });
            });

            // Dragover + drop on ALL optimized items (including locked — as drop targets)
            const allOptItems = dialog.querySelectorAll(".svp-optdlg-list-opt .svp-optdlg-item");
            allOptItems.forEach((el) => {
                el.addEventListener("dragover", (e) => {
                    (e as DragEvent).preventDefault();
                    dialog.querySelectorAll(".svp-optdlg-item-dragover").forEach((o) => o.classList.remove("svp-optdlg-item-dragover"));
                    (el as HTMLElement).classList.add("svp-optdlg-item-dragover");
                });
                el.addEventListener("drop", (e) => {
                    (e as DragEvent).preventDefault();
                    const toIdx = parseInt((el as HTMLElement).dataset.idx ?? "-1", 10);
                    if (dragIdx == null || dragIdx === toIdx || toIdx < 0) return;
                    const [moved] = optList.splice(dragIdx, 1);
                    optList.splice(toIdx, 0, moved);
                    recalcOptTime();
                    computeReschedule();
                    manuallyAdjusted = true;
                    renderDialog();
                    if (previewActive) this._showDualRoutePreview(currentOrder, optList);
                });
            });

            // Hover → highlight map pin (debounced)
            allOptItems.forEach((el) => {
                el.addEventListener("mouseenter", () => {
                    const idx = parseInt((el as HTMLElement).dataset.idx ?? "-1", 10);
                    if (idx >= 0 && idx < optList.length) {
                        this._highlightMapPin(optList[idx]);
                    }
                });
                el.addEventListener("mouseleave", () => {
                    this._unhighlightMapPin();
                });
            });

            // Scroll sync between current and optimized list panes
            const currentPane = dialog.querySelector(".svp-optdlg-list-pane-current") as HTMLElement | null;
            const optPane = dialog.querySelector(".svp-optdlg-list-pane-opt") as HTMLElement | null;
            let syncing = false;
            if (currentPane && optPane) {
                currentPane.addEventListener("scroll", () => {
                    if (syncing) return;
                    syncing = true;
                    optPane.scrollTop = currentPane.scrollTop;
                    syncing = false;
                });
                optPane.addEventListener("scroll", () => {
                    if (syncing) return;
                    syncing = true;
                    currentPane.scrollTop = optPane.scrollTop;
                    syncing = false;
                });
            }
        };

        const cleanup = () => {
            this._removeDualRoutePreview();
            this._unhighlightMapPin();
            dialog.remove();
        };

        renderDialog();
        this._container.querySelector(".svp-root")?.appendChild(dialog);
    }

    private _setOptimizeButtonState(state: "ready" | "loading"): void {
        const btn = this._optimizeBtn;
        if (!btn) return;
        if (state === "loading") {
            btn.disabled = true;
            btn.textContent = "Optimizing\u2026";
        } else {
            btn.disabled = false;
            btn.textContent = "Optimize route";
        }
    }

    private _setActiveMode(mode: "plan" | "optimize" | "invitations" | "findProspects" | "territory"): void {
        console.log('[Mode] changing from', this._activeMode, 'to', mode);
        this._activeMode = mode;
        this._updateHeaderButtonStyles();

        // Sync panel visibility with mode
        if (mode !== 'invitations') {
            const overlay = document.body.querySelector('.svp-inv-overlay');
            if (overlay) overlay.remove();
        }
    }

    private _updateHeaderButtonStyles(): void {
        const buttons: { el: HTMLButtonElement | null; mode: string }[] = [
            { el: this._optimizeBtn, mode: "optimize" },
            { el: this._invitationsBtn, mode: "invitations" },
            { el: this._prospectBtn, mode: "findProspects" },
            { el: this._territoryBtn, mode: "territory" },
        ];

        buttons.forEach(({ el, mode }) => {
            if (!el) {
                console.warn('[Header] button ref missing for mode:', mode);
                return;
            }
            const isActive = this._activeMode === mode;
            el.style.background  = isActive ? '#0078d4' : '#ffffff';
            el.style.color       = isActive ? '#ffffff' : '#323130';
            el.style.borderColor = isActive ? '#0078d4' : '#8a8886';
            el.style.fontWeight  = isActive ? '600'     : '400';
        });

        console.log('[Header] styles updated for mode:', this._activeMode);
    }

    /* ── Re-optimize keeping locked stops in place ── */
    private _optimizeWithLocks(
        currentList: VisitItem[],
        locked: Set<string>,
        matrix: number[][],
        geocodedRef: VisitItem[],
    ): VisitItem[] {
        // Extract unlocked stops, optimize them, then re-insert locked stops at their positions
        const lockedPositions: { idx: number; visit: VisitItem }[] = [];
        const unlocked: { origIdx: number; visit: VisitItem }[] = [];

        currentList.forEach((v, i) => {
            if (locked.has(v.id)) lockedPositions.push({ idx: i, visit: v });
            else unlocked.push({ origIdx: geocodedRef.indexOf(v), visit: v });
        });

        if (unlocked.length < 2) return currentList;

        // Build sub-matrix for unlocked stops
        const subIndices = unlocked.map((u) => u.origIdx);
        const subN = subIndices.length;
        const subMatrix: number[][] = Array.from({ length: subN }, (_, i) =>
            Array.from({ length: subN }, (_, j) =>
                matrix[subIndices[i]]?.[subIndices[j]] ?? 99999
            )
        );

        const { optimizedIndices } = this._optimizeOrder(subMatrix, subN);
        const reorderedUnlocked = optimizedIndices.map((i) => unlocked[i].visit);

        // Rebuild full list with locked stops in their original positions
        const result: VisitItem[] = [];
        let uIdx = 0;
        for (let i = 0; i < currentList.length; i++) {
            const lockedHere = lockedPositions.find((lp) => lp.idx === i);
            if (lockedHere) {
                result.push(lockedHere.visit);
            } else if (uIdx < reorderedUnlocked.length) {
                result.push(reorderedUnlocked[uIdx++]);
            }
        }
        return result;
    }

    /* ── Dual route preview on map ── */
    private _dualPreviewLayers: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _dualPreviewSource: any = null;

    private _showDualRoutePreview(currentOrder: VisitItem[], optimizedOrder: VisitItem[]): void {
        this._removeDualRoutePreview();
        if (!this._map) return;

        const curCoords = currentOrder
            .filter((v) => v.lat != null && v.lng != null)
            .map((v) => [v.lng!, v.lat!] as [number, number]);
        const optCoords = optimizedOrder
            .filter((v) => v.lat != null && v.lng != null)
            .map((v) => [v.lng!, v.lat!] as [number, number]);

        if (curCoords.length < 2 && optCoords.length < 2) return;

        const src = new atlas.source.DataSource("opt-preview-source");
        this._map.sources.add(src);
        this._dualPreviewSource = src;

        // Current route (dashed gray)
        if (curCoords.length >= 2) {
            src.add(new atlas.data.Feature(new atlas.data.LineString(curCoords), { route: "current" }));
        }
        // Optimized route (solid blue)
        if (optCoords.length >= 2) {
            src.add(new atlas.data.Feature(new atlas.data.LineString(optCoords), { route: "optimized" }));
        }

        // Gray dashed line for current
        const curLayer = new atlas.layer.LineLayer(src, "opt-preview-current", {
            strokeColor: "#c8c6c4",
            strokeWidth: 3,
            strokeDashArray: [4, 4],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        this._map.layers.add(curLayer);
        this._dualPreviewLayers.push("opt-preview-current");

        // Blue solid line for optimized
        const optLayer = new atlas.layer.LineLayer(src, "opt-preview-optimized", {
            strokeColor: "#0078d4",
            strokeWidth: 3,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        this._map.layers.add(optLayer);
        this._dualPreviewLayers.push("opt-preview-optimized");
    }

    private _removeDualRoutePreview(): void {
        if (!this._map) return;
        for (const id of this._dualPreviewLayers) {
            try { this._map.layers.remove(id); } catch { /* ok */ }
        }
        this._dualPreviewLayers = [];
        if (this._dualPreviewSource) {
            try { this._map.sources.remove(this._dualPreviewSource); } catch { /* ok */ }
            this._dualPreviewSource = null;
        }
    }

    /* ── Highlight a map pin on hover ── */
    private _highlightedMarker: atlas.HtmlMarker | null = null;

    private _highlightMapPin(visit: VisitItem): void {
        this._unhighlightMapPin();
        if (!this._map || visit.lat == null || visit.lng == null) return;
        const marker = new atlas.HtmlMarker({
            position: [visit.lng, visit.lat],
            color: "#0078d4",
            text: "\u25CF",
        });
        this._map.markers.add(marker);
        this._highlightedMarker = marker;
    }

    private _unhighlightMapPin(): void {
        if (this._highlightedMarker && this._map) {
            try {
                // Remove by clearing and re-adding visit markers
                // HtmlMarker has no individual remove — just clear the highlight
                this._map.markers.clear();
                // Re-add visit route markers
                const geoVisits = this._visits.filter((v) => v.lat != null && v.lng != null);
                for (let i = 0; i < geoVisits.length; i++) {
                    const v = geoVisits[i];
                    const m = new atlas.HtmlMarker({
                        position: [v.lng!, v.lat!],
                        text: String(i + 1),
                        color: "#0078D4",
                    });
                    this._map.markers.add(m);
                }
            } catch { /* ok */ }
            this._highlightedMarker = null;
        }
    }

    private _showUndoBar(message?: string): void {
        const existing = this._container.querySelector(".svp-undo-bar");
        if (existing) existing.remove();

        const bar = document.createElement("div");
        bar.className = "svp-undo-bar";
        bar.innerHTML = `
            <span>${message ?? "\u2705 Route optimized"}</span>
            <button class="svp-undo-btn">\u21A9 Undo</button>`;

        const summary = this._container.querySelector(".svp-journey-summary");
        summary?.after(bar);

        bar.querySelector(".svp-undo-btn")?.addEventListener("click", async () => {
            this._visits = [...this._preOptimizationOrder];
            this._routePoints = [];
            this._legSummaries = [];
            await this._calculateRoute();
            this._renderList();
            this._renderJourneySummary();
            if (this._map) { this._map.dispose(); this._map = null; }
            this._renderMap();
            this._wireOptimizeButton();
            bar.remove();
        });

        setTimeout(() => bar.remove(), 10000);
    }

    /* ───────────────── PRIORITY VISIT HANDLING ───────────────── */

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async _handlePriorityVisit(priorityAppt: any): Promise<void> {
        const activityId = priorityAppt.activityid as string;
        this._knownPriorityIds.add(activityId);

        const localAppt = this._visits.find((v) => v.id === activityId);
        if (localAppt) localAppt.isPriority = true;

        this._highlightPriorityCard(activityId);

        const accountName =
            localAppt?.accountName ?? priorityAppt.subject ?? "A visit";

        this._showPriorityNotification(
            activityId,
            accountName,
            async () => {
                this._moveToTop(activityId);
                this._renderList();
                this._routePoints = [];
                this._legSummaries = [];
                await this._calculateRoute();
                this._renderJourneySummary();
                if (this._map) {
                    this._map.dispose();
                    this._map = null;
                }
                this._renderMap();
                this._wireOptimizeButton();
            }
        );
    }

    private _moveToTop(activityId: string): void {
        const index = this._visits.findIndex((v) => v.id === activityId);
        if (index <= 0) return;
        const [appt] = this._visits.splice(index, 1);
        this._visits.unshift(appt);
    }

    private _showPriorityNotification(
        activityId: string,
        accountName: string,
        onConfirm: () => Promise<void>
    ): void {
        this._container.querySelector(".priority-notification")?.remove();

        const banner = document.createElement("div");
        banner.className = "priority-notification";
        banner.dataset.activityid = activityId;
        banner.innerHTML = `
            <div class="priority-notification-content">
                <div class="priority-notification-header">
                    <span class="priority-icon">\uD83D\uDEA8</span>
                    <span class="priority-title">Urgent Visit Flagged</span>
                    <button class="priority-dismiss">\u2715</button>
                </div>
                <div class="priority-body">
                    <strong>${this._escapeHtml(accountName)}</strong> has been marked as
                    a priority visit. Move it to the top of your route?
                </div>
                <div class="priority-actions">
                    <button class="priority-ignore-btn">Keep Current Order</button>
                    <button class="priority-confirm-btn">\uD83D\uDD1D Move to Top &amp; Recalculate</button>
                </div>
            </div>`;

        const listPanel = this._container.querySelector(".svp-list-panel");
        listPanel?.prepend(banner);

        banner.querySelector(".priority-confirm-btn")
            ?.addEventListener("click", async () => {
                banner.remove();
                await onConfirm();
            });

        const dismiss = () => {
            banner.remove();
            this._container
                .querySelector(`.svp-tl-visit-item[data-appointment-id="${activityId}"]`)
                ?.classList.remove("priority-card-highlight");
        };

        banner.querySelector(".priority-ignore-btn")
            ?.addEventListener("click", dismiss);
        banner.querySelector(".priority-dismiss")
            ?.addEventListener("click", dismiss);

        setTimeout(() => {
            if (banner.isConnected) banner.remove();
        }, 30000);
    }

    private _highlightPriorityCard(activityId: string): void {
        const card = this._container.querySelector(
            `.svp-tl-visit-item[data-appointment-id="${activityId}"]`
        );
        if (!card) return;

        card.classList.add("priority-card-highlight");

        const existingBadge = card.querySelector(".priority-badge");
        if (!existingBadge) {
            const badge = document.createElement("div");
            badge.className = "priority-badge";
            badge.textContent = "\uD83D\uDEA8 URGENT";
            card.querySelector(".svp-list-details")?.prepend(badge);
        }
    }

    /* ───────────────── POLLING FOR CANCELLATIONS ───────────────── */

    private _startPolling(): void {
        this._lastKnownActivityIds = new Set(this._visits.map((v) => v.id));
        this._pollingInterval = window.setInterval(async () => {
            await this._checkForCancellations();
        }, 60000);
    }

    private async _checkForCancellations(): Promise<void> {
        if (!this._context || !this._planId) return;
        try {
            const result = await this._context.webAPI.retrieveMultipleRecords(
                "appointment",
                `?$select=activityid,statecode,subject,${this._isPriorityField}` +
                `&$filter=_${this._planLookupField}_value eq ${this._planId}`
            );

            // --- Cancellation detection ---
            // Appointment statecode: 0=Open, 1=Completed, 2=Canceled, 3=Scheduled.
            // Only statecode 2 (Canceled) should trigger the cancellation banner.
            // (Previously this also matched statecode 1, which swept every
            //  checked-out visit out of the list on the next poll tick.)
            const cancelledIds = result.entities
                .filter((a) => a["statecode"] === 2)
                .map((a) => a["activityid"] as string);

            const affectedIds = cancelledIds.filter(
                (id) => this._lastKnownActivityIds.has(id)
            );

            if (affectedIds.length > 0) {
                console.log("[SVP] Cancellations detected:", affectedIds);
                await this._handleCancellations(affectedIds);
            }

            // --- Priority detection ---
            const newlyPrioritised = result.entities.filter(
                (a) =>
                    a[this._isPriorityField] === true &&
                    this._lastKnownActivityIds.has(a["activityid"] as string) &&
                    !this._knownPriorityIds.has(a["activityid"] as string)
            );

            if (newlyPrioritised.length > 0) {
                console.log("[SVP] New priority visits detected:", newlyPrioritised);
                for (const priorityAppt of newlyPrioritised) {
                    await this._handlePriorityVisit(priorityAppt);
                }
            }
        } catch (err) {
            console.error("[SVP] Polling error:", err);
        }
    }

    private async _handleCancellations(cancelledIds: string[]): Promise<void> {
        // Show the banner BEFORE we mutate _visits so name lookup still works.
        this._showCancellationBanner(cancelledIds);

        const cancelledSet = new Set(cancelledIds);
        // Only drop visits that are actually still in our list AND truly canceled.
        // Completed visits (statecode 1) must remain visible on list & map.
        const before = this._visits.length;
        this._visits = this._visits.filter((v) => !cancelledSet.has(v.id));
        this._lastKnownActivityIds = new Set(this._visits.map((v) => v.id));

        if (this._visits.length === before) {
            // Nothing actually removed (cancellations were for visits we no
            // longer track) – just refresh styling and bail out.
            this._refreshMapAfterStateChange();
            return;
        }

        this._renderList();
        this._renderJourneySummary();

        if (this._visits.length > 0) {
            // Recompute the route around the remaining stops, but DO NOT
            // dispose & rebuild the map – we just refresh markers & route
            // segments in place so completed stops stay rendered.
            this._routePoints = [];
            this._legSummaries = [];
            await this._calculateRoute();
            this._refreshMapAfterStateChange();
        } else {
            this._showEmptyState();
        }
    }

    private _showCancellationBanner(cancelledIds: string[]): void {
        const names = cancelledIds.map((id) => {
            const appt = this._visits.find((v) => v.id === id);
            return appt?.accountName ?? appt?.subject ?? "Unknown visit";
        });

        const banner = document.createElement("div");
        banner.className = "cancellation-banner";
        banner.innerHTML = `
            <div class="cancellation-banner-content">
                <span>\u274C ${this._escapeHtml(names.join(", "))}
                    ${names.length > 1 ? "have" : "has"} been cancelled
                    and removed from your route.</span>
                <button class="banner-dismiss">\u2715</button>
            </div>`;

        const container = this._container.querySelector(".svp-list-panel");
        container?.prepend(banner);

        banner.querySelector(".banner-dismiss")
            ?.addEventListener("click", () => banner.remove());
        setTimeout(() => banner.remove(), 8000);
    }

    private _showEmptyState(message?: string): void {
        const listPanel = this._container.querySelector(".svp-list-panel");
        if (listPanel) {
            listPanel.innerHTML = `
                <div class="empty-state">
                    <div style="font-size:32px">\uD83D\uDDFA\uFE0F</div>
                    <div>${message ?? "No appointments in this plan yet."}</div>
                    <div style="font-size:11px;color:#888;margin-top:4px">
                        Use the \u201CCreate Appointments\u201D button to add visits to this plan.
                    </div>
                </div>`;
        }
        this._clearMapRoute();
    }

    private _clearMapRoute(): void {
        if (!this._map) return;
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const mapAny = this._map as any;
        try { mapAny.layers.remove("route-line"); } catch { /* noop */ }
        try { mapAny.layers.remove("route-outline"); } catch { /* noop */ }
        try { mapAny.sources.remove("route-source"); } catch { /* noop */ }
        this._map.markers.clear();
        mapAny.setCamera({ center: [-1.5, 52.5], zoom: 6 });
        /* eslint-enable @typescript-eslint/no-explicit-any */
    }

    /* ───────────────── DEV / HARNESS DETECTION ───────────────── */

    private _detectHarness(): boolean {
        // PCF test harness runs on localhost with a specific container structure
        return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    }

    private _loadMockData(): void {
        const today = new Date();
        const h = (hour: number, min: number): Date =>
            new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, min);

        this._visits = [
            { id: "m1", subject: "Daylight Group - Quarterly Review", scheduledStart: h(8, 0), scheduledEnd: h(9, 0), location: "Ådalsvej 99, 2970 Hørsholm, Denmark", accountName: "Daylight Group A/S", accountId: "mock-acc-1", address: "Ådalsvej 99, Hørsholm, 2970, Denmark", lat: 55.8761, lng: 12.5019, geocodeError: false, driveSec: 1320, driveMeters: 18600, eta: "07:42", opportunityId: "mock-opp-1", opportunityName: "Q2 Skylight Expansion", isPriority: false, invitationStatus: 100000001, accountCity: "Hørsholm", estimatedValue: 450000, salesStage: "Propose", estimatedCloseDate: "2026-06-15", ownerName: "Lars Jensen", regardingType: "opportunity", actualstart: null },
            { id: "m2", subject: "Site Visit - Lyngby Warehouse", scheduledStart: h(9, 30), scheduledEnd: h(10, 30), location: "Lyngby Hovedgade 56, 2800 Lyngby, Denmark", accountName: "Nordic Supplies ApS", accountId: "mock-acc-2", address: "Lyngby Hovedgade 56, Lyngby, 2800, Denmark", lat: 55.7704, lng: 12.5037, geocodeError: false, driveSec: 960, driveMeters: 12500, eta: "09:16", opportunityId: "mock-opp-2", opportunityName: "Warehouse Roof Replacement", isPriority: false, invitationStatus: 100000002, accountCity: "Lyngby", estimatedValue: 280000, salesStage: "Develop", estimatedCloseDate: "2026-08-01", ownerName: "Maria Hansen", regardingType: "opportunity", actualstart: null },
            { id: "m3", subject: "Sales Demo - Copenhagen Office", scheduledStart: h(11, 0), scheduledEnd: h(12, 0), location: "Nyhavn 53, 1051 Copenhagen, Denmark", accountName: "Skylight Solutions A/S", accountId: "mock-acc-3", address: "Nyhavn 53, Copenhagen, 1051, Denmark", lat: 55.6794, lng: 12.5903, geocodeError: false, driveSec: 1080, driveMeters: 14200, eta: "10:48", opportunityId: null, opportunityName: null, isPriority: false, invitationStatus: 100000003, accountCity: "Copenhagen", estimatedValue: null, salesStage: null, estimatedCloseDate: null, ownerName: null, regardingType: "account", actualstart: null },
            { id: "m4", subject: "Lunch - Client Consultation", scheduledStart: h(14, 0), scheduledEnd: h(14, 30), location: "Strøget 28, 1148 Copenhagen, Denmark", accountName: "BuildRight Denmark", accountId: "mock-acc-4", address: "Strøget 28, Copenhagen, 1148, Denmark", lat: 55.6772, lng: 12.5738, geocodeError: false, driveSec: 420, driveMeters: 2800, eta: "12:07", opportunityId: "mock-opp-4", opportunityName: "Energy-Efficient Glazing Contract", isPriority: false, invitationStatus: 100000000, accountCity: "Copenhagen", estimatedValue: 175000, salesStage: "Qualify", estimatedCloseDate: "2026-09-30", ownerName: "Peter Nielsen", regardingType: "opportunity", actualstart: null },
            { id: "m5", subject: "Roof Installation Inspection", scheduledStart: h(16, 0), scheduledEnd: h(17, 0), location: "Vesterbrogade 3, 1620 Copenhagen, Denmark", accountName: "Hansen Byg & Montage", accountId: "mock-acc-5", address: "Vesterbrogade 3, Copenhagen, 1620, Denmark", lat: 55.6736, lng: 12.5681, geocodeError: false, driveSec: 540, driveMeters: 3500, eta: "13:39", opportunityId: "mock-opp-5", opportunityName: "Renovation Phase 2", isPriority: true, invitationStatus: 100000001, accountCity: "Copenhagen", estimatedValue: 620000, salesStage: "Close", estimatedCloseDate: "2026-05-10", ownerName: "Lars Jensen", regardingType: "opportunity", actualstart: null },
            { id: "m6", subject: "Architect Meeting", scheduledStart: h(17, 15), scheduledEnd: h(18, 0), location: "Amager Strandvej 390, 2770 Kastrup, Denmark", accountName: "Arkitektgruppen CPH", accountId: "mock-acc-6", address: "Amager Strandvej 390, Kastrup, 2770, Denmark", lat: 55.6415, lng: 12.6506, geocodeError: false, driveSec: 900, driveMeters: 9800, eta: "15:45", opportunityId: "mock-opp-6", opportunityName: "New Build Daylight Design", isPriority: false, invitationStatus: 100000002, accountCity: "Kastrup", estimatedValue: 340000, salesStage: "Propose", estimatedCloseDate: "2026-07-20", ownerName: "Maria Hansen", regardingType: "opportunity", actualstart: null },
            { id: "m7", subject: "Follow-up (no address)", scheduledStart: h(18, 0), scheduledEnd: null, location: "", accountName: null, accountId: null, address: null, lat: null, lng: null, geocodeError: true, driveSec: null, driveMeters: null, eta: null, opportunityId: null, opportunityName: null, isPriority: false, invitationStatus: 100000000, accountCity: null, estimatedValue: null, salesStage: null, estimatedCloseDate: null, ownerName: null, regardingType: null, actualstart: null },
        ];

        // Mock leg summaries
        this._legSummaries = [
            { travelTimeSeconds: 1320, lengthInMeters: 18600 },
            { travelTimeSeconds: 960, lengthInMeters: 12500 },
            { travelTimeSeconds: 1080, lengthInMeters: 14200 },
            { travelTimeSeconds: 420, lengthInMeters: 2800 },
            { travelTimeSeconds: 540, lengthInMeters: 3500 },
            { travelTimeSeconds: 900, lengthInMeters: 9800 },
        ];

        // Mock current position (near Copenhagen central station)
        this._currentPosition = [12.5655, 55.6728];
    }

    /* ───────────────── MOCK MAP (Leaflet via CDN for local testing) ───────────────── */

    private _renderMockMap(): void {
        // Inject Leaflet for local preview (not used in production)
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);

        const script = document.createElement("script");
        script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
        script.onload = () => this._buildLeafletMap();
        script.onerror = () => {
            this._mapEl.innerHTML = `<div class="svp-error">Could not load map preview library.</div>`;
        };
        document.head.appendChild(script);
    }

    private _buildLeafletMap(): void {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const Lf = (window as any).L;
        if (!Lf) return;

        const map = Lf.map(this._mapEl, { attributionControl: true }).setView([55.72, 12.55], 11);
        Lf.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 18,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> | Dev preview',
        }).addTo(map);

        const coords: [number, number][] = [];

        this._visits.forEach((v, i) => {
            if (v.lat === null || v.lng === null) return;
            const latlng: [number, number] = [v.lat, v.lng];
            coords.push(latlng);

            const icon = Lf.divIcon({
                className: "",
                html: `<div class="svp-marker-icon">${i + 1}</div>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14],
            });

            Lf.marker(latlng, { icon })
                .addTo(map)
                .bindPopup(`<b>${this._escapeHtml(v.accountName ?? v.subject)}</b><br/>${this._escapeHtml(v.address ?? v.location)}`);
        });

        if (coords.length >= 2) {
            Lf.polyline(coords, { color: "#0078d4", weight: 3, opacity: 0.7, dashArray: "8 4" }).addTo(map);
        }
        if (coords.length > 0) {
            const bounds = Lf.latLngBounds(coords);
            if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
        }
        setTimeout(() => map.invalidateSize(), 200);
        /* eslint-enable @typescript-eslint/no-explicit-any */
    }

    /* ───────────────── INVITATION STATUS PILL ───────────────── */

    private _getInvitationStatusPill(status: number): string {
        switch (status) {
            case STATUS.invitation.invited:
                return `<span class="inv-pill inv-sent">Invited</span>`;
            case STATUS.invitation.accepted:
                return `<span class="inv-pill inv-accepted">Confirmed</span>`;
            case STATUS.invitation.declined:
                return `<span class="inv-pill inv-declined">Declined</span>`;
            default:
                return `<span class="inv-pill inv-not-sent">Not Sent</span>`;
        }
    }

    /* ───────────────── SEND INVITATIONS ───────────────── */

    private _wireSendInvitationsButton(): void {
        const btn = this._container.querySelector("#sendInvitationsBtn");
        btn?.addEventListener("click", async () => {
            this._setActiveMode("invitations");
            await this._openInvitationPanel();
        });
    }

    // Invitation template (editable by the rep)
    private _invitationBodyTemplate =
        `Hi [contact first name],\n\n` +
        `I'd like to stop by for a visit on [weekday] [date] at [start time] to discuss ` +
        `how [rep company name] solutions could support your upcoming [opportunity name].\n\n` +
        `The visit will take approximately [duration] hour(s). Please accept or decline ` +
        `this invitation to confirm your availability \u2014 if the time doesn't work, feel ` +
        `free to suggest an alternative.\n\n` +
        `Looking forward to seeing you.\n\n` +
        `Best regards,\n` +
        `[Rep full name]\n` +
        `[Rep job title], [Rep company name]\n` +
        `[Rep phone] \u00B7 [Rep email]`;

    private _invitationEdited = false;

    private async _openInvitationPanel(): Promise<void> {
        if (!this._context || this._visits.length === 0) {
            this._showMapBanner("\u26A0\uFE0F No appointments in this plan.", "warning");
            this._setActiveMode("plan");
            return;
        }

        // Remove any existing panel
        document.body.querySelector(".svp-inv-overlay")?.remove();

        // Build overlay
        const overlay = document.createElement("div");
        overlay.className = "svp-inv-overlay";

        const closePanel = () => { overlay.remove(); this._setActiveMode("plan"); };

        overlay.innerHTML = `<div class="svp-inv-panel">` +
            `<div class="svp-inv-panel-inner">` +
            `<div class="svp-inv-header">` +
            `<span class="svp-inv-header-title">Send Invitations</span>` +
            `<button class="svp-inv-close">\u2715</button>` +
            `</div>` +
            `<div class="svp-inv-body"><div class="svp-inv-loading">Loading recipients\u2026</div></div>` +
            `</div></div>`;

        // Append to document.body so the overlay sits above all D365 chrome
        document.body.appendChild(overlay);

        overlay.querySelector(".svp-inv-close")?.addEventListener("click", () => closePanel());
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closePanel();
        });

        // Fetch contact data for each visit
        const recipients = await this._fetchInvitationRecipients();

        const body = overlay.querySelector(".svp-inv-body") as HTMLElement;
        this._renderInvitationPanelContent(body, recipients, overlay);
    }

    private async _fetchInvitationRecipients(): Promise<{
        visitIndex: number;
        appointmentId: string;
        accountName: string;
        contactId: string | null;
        contactFirstName: string;
        contactFullName: string;
        contactEmail: string | null;
        contactInitials: string;
        invitationStatus: number;
        opportunityName: string | null;
        scheduledStart: Date;
        scheduledEnd: Date | null;
        status: "ready" | "no-email" | "already-sent";
    }[]> {
        const recipients: {
            visitIndex: number;
            appointmentId: string;
            accountName: string;
            contactId: string | null;
            contactFirstName: string;
            contactFullName: string;
            contactEmail: string | null;
            contactInitials: string;
            invitationStatus: number;
            opportunityName: string | null;
            scheduledStart: Date;
            scheduledEnd: Date | null;
            status: "ready" | "no-email" | "already-sent";
        }[] = [];

        if (!this._context) return recipients;
        const ctx = this._context;

        await Promise.all(this._visits.map(async (v, idx) => {
            let contactId: string | null = null;
            let contactFirstName = "";
            let contactFullName = "";
            let contactEmail: string | null = null;

            // Try to get primary contact via account
            if (v.accountId) {
                try {
                    const acc = await ctx.webAPI.retrieveRecord(
                        "account", v.accountId,
                        "?$select=name&$expand=primarycontactid($select=contactid,firstname,fullname,emailaddress1)"
                    );
                    const pc = acc.primarycontactid;
                    if (pc) {
                        contactId = pc.contactid ?? null;
                        contactFirstName = pc.firstname ?? "";
                        contactFullName = pc.fullname ?? "";
                        contactEmail = pc.emailaddress1 ?? null;
                    }
                } catch (err) {
                    console.warn("[SVP] Could not fetch primary contact for account", v.accountId, err);
                }
            }

            const initials = contactFullName
                ? contactFullName.split(" ").map((w: string) => w[0]).join("").substring(0, 2).toUpperCase()
                : (v.accountName ?? "?").split(/\s+/).filter((w: string) => w.length > 0).map((w: string) => w[0]).join("").substring(0, 2).toUpperCase();

            let status: "ready" | "no-email" | "already-sent" = "ready";
            if (v.invitationStatus === STATUS.invitation.invited || v.invitationStatus === STATUS.invitation.accepted) {
                status = "already-sent";
            } else if (!contactEmail) {
                status = "no-email";
            }

            recipients.push({
                visitIndex: idx,
                appointmentId: v.id,
                accountName: v.accountName ?? v.subject,
                contactId,
                contactFirstName,
                contactFullName,
                contactEmail,
                contactInitials: initials,
                invitationStatus: v.invitationStatus,
                opportunityName: v.opportunityName,
                scheduledStart: v.scheduledStart,
                scheduledEnd: v.scheduledEnd,
                status,
            });
        }));

        // Sort by visit order (same as timeline)
        recipients.sort((a, b) => a.visitIndex - b.visitIndex);
        return recipients;
    }

    private _invContactSearchTimer: ReturnType<typeof setTimeout> | null = null;

    private _renderInvitationPanelContent(
        body: HTMLElement,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recipients: any[],
        overlay: HTMLElement
    ): void {
        // Build recipients list
        const recipientRows = recipients.map((r, i) => {
            r.resend = false;
            const hasContact = !!r.contactId;

            let statusBadge: string;
            let resendRowBtn = "";
            if (r.status === "ready") {
                statusBadge = `<span class="svp-inv-badge svp-inv-badge-ready">Ready</span>`;
            } else if (r.status === "no-email") {
                statusBadge = `<span class="svp-inv-badge svp-inv-badge-noemail">${hasContact ? "No email" : "No contact"}</span>`;
            } else {
                resendRowBtn = `<button class="svp-inv-resend-row-btn" data-idx="${i}">Resend</button>`;
                statusBadge = `<span class="svp-inv-badge svp-inv-badge-sent">Already sent</span>`;
            }

            const disabled = (r.status === "no-email" || r.status === "already-sent") ? "disabled" : "";
            const checked = r.status === "ready" ? "checked" : "";

            let emailLine: string;
            if (r.contactEmail) {
                emailLine = this._escapeHtml(r.contactEmail);
            } else if (r.contactId) {
                emailLine = `<span class="svp-inv-no-contact">No email on contact</span>`;
            } else {
                emailLine = `<span class="svp-inv-no-contact">No primary contact \u2014 add one to enable</span>`;
            }

            let avatarBg: string;
            let avatarFg = "#fff";
            if (!hasContact) {
                avatarBg = "#F3F2F1";
                avatarFg = "#8A8886";
            } else if (r.status === "ready") {
                avatarBg = "#0078d4";
            } else if (r.status === "no-email") {
                avatarBg = "#d13438";
            } else {
                avatarBg = "#8a8886";
            }

            const icon = r.contactId ? "\u270F\uFE0F" : "\u2795";
            const editBtn = `<button class="svp-inv-row-edit" data-idx="${i}" title="${r.contactId ? "Edit recipient" : "Add contact"}">${icon}</button>`;

            return `<div class="svp-inv-recipient-wrapper" data-index="${i}">` +
                `<div class="svp-inv-recipient" data-index="${i}">` +
                `<input type="checkbox" class="svp-inv-check" data-idx="${i}" ${checked} ${disabled}>` +
                `<div class="svp-inv-avatar" style="background:${avatarBg};color:${avatarFg}">${this._escapeHtml(r.contactInitials)}</div>` +
                `<div class="svp-inv-recipient-info">` +
                `<div class="svp-inv-account-name">${this._escapeHtml(r.accountName)}</div>` +
                `<div class="svp-inv-contact-line">${r.contactFullName ? this._escapeHtml(r.contactFullName) + " \u00B7 " : ""}${emailLine}</div>` +
                `</div>` +
                `${resendRowBtn}` +
                `${statusBadge}` +
                `${editBtn}` +
                `</div>` +
                `</div>`;
        }).join("");

        // Preview template
        const previewBody = this._escapeHtml(this._invitationBodyTemplate)
            .replace(/\n/g, "<br>");

        body.innerHTML =
            `<div class="svp-inv-section">` +
            `<div class="svp-inv-section-title">Recipients</div>` +
            `<div class="svp-inv-recipients-list">${recipientRows}</div>` +
            `</div>` +
            `<div class="svp-inv-section">` +
            `<div class="svp-inv-section-title">Invitation Preview</div>` +
            `<div class="svp-inv-preview-subject">Subject: Visit from [rep company name] \u2014 [weekday] [date], [start time]\u2013[end time]</div>` +
            `<div class="svp-inv-preview-body">${previewBody}</div>` +
            `<button class="svp-inv-edit-btn">\u270F\uFE0F Edit invitation text</button>` +
            `<textarea class="svp-inv-edit-area" style="display:none">${this._escapeHtml(this._invitationBodyTemplate)}</textarea>` +
            `</div>` +
            `<div class="svp-inv-summary">` +
            `<span class="svp-inv-summary-ready"></span>` +
            `<span class="svp-inv-summary-resend" style="display:none"></span>` +
            `<span class="svp-inv-summary-noemail"></span>` +
            `<span class="svp-inv-summary-sent"></span>` +
            `</div>` +
            `<div class="svp-inv-footer">` +
            `<button class="svp-inv-cancel-btn">Cancel</button>` +
            `<button class="svp-inv-send-btn">Send invitations (0)</button>` +
            `</div>`;

        // Update summary counts (reusable)
        const updateSummary = () => {
            const ready = recipients.filter((r) => r.status === "ready").length;
            const noEmail = recipients.filter((r) => r.status === "no-email").length;
            const markedResend = recipients.filter((r) => r.resend === true).length;
            const sent = recipients.filter((r) => r.status === "already-sent" && !r.resend).length;

            const readyEl = body.querySelector(".svp-inv-summary-ready");
            const resendEl = body.querySelector(".svp-inv-summary-resend") as HTMLElement;
            const noEmailEl = body.querySelector(".svp-inv-summary-noemail");
            const sentEl = body.querySelector(".svp-inv-summary-sent");
            if (readyEl) {
                readyEl.className = "svp-inv-summary-item svp-inv-badge-ready";
                readyEl.textContent = `${ready} ready`;
            }
            if (resendEl) {
                resendEl.className = "svp-inv-summary-item svp-inv-badge-resend";
                resendEl.textContent = `${markedResend} to resend`;
                resendEl.style.display = markedResend > 0 ? "" : "none";
            }
            if (noEmailEl) {
                noEmailEl.className = "svp-inv-summary-item svp-inv-badge-noemail";
                noEmailEl.textContent = `${noEmail} missing email`;
            }
            if (sentEl) {
                sentEl.className = "svp-inv-summary-item svp-inv-badge-sent";
                sentEl.textContent = `${sent} already sent`;
            }
            // Update send button — includes both ready and resend
            const allChecked = Array.from(body.querySelectorAll<HTMLInputElement>(".svp-inv-check:checked"));
            const totalToSend = allChecked.filter(c => {
                const i = parseInt(c.dataset.idx ?? "-1", 10);
                return i >= 0 && (recipients[i]?.status === "ready" || recipients[i]?.resend === true);
            }).length;
            const sendBtn = body.querySelector(".svp-inv-send-btn") as HTMLButtonElement;
            if (sendBtn) {
                sendBtn.textContent = `Send invitations (${totalToSend})`;
                sendBtn.disabled = totalToSend === 0;
            }
        };
        updateSummary();

        // Wire edit button (invitation text)
        const editBtn = body.querySelector(".svp-inv-edit-btn") as HTMLElement;
        const editArea = body.querySelector(".svp-inv-edit-area") as HTMLTextAreaElement;
        const previewEl = body.querySelector(".svp-inv-preview-body") as HTMLElement;
        editBtn?.addEventListener("click", () => {
            if (editArea.style.display === "none") {
                editArea.style.display = "";
                previewEl.style.display = "none";
                editBtn.textContent = "\u2705 Save changes";
            } else {
                this._invitationBodyTemplate = editArea.value;
                this._invitationEdited = true;
                previewEl.innerHTML = this._escapeHtml(editArea.value).replace(/\n/g, "<br>");
                editArea.style.display = "none";
                previewEl.style.display = "";
                editBtn.textContent = "\u270F\uFE0F Edit invitation text";
            }
        });

        // Wire row edit buttons (inline edit panel)
        body.querySelectorAll(".svp-inv-row-edit").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const idx = parseInt((e.currentTarget as HTMLElement).dataset.idx ?? "-1", 10);
                if (idx < 0) return;
                this._toggleRecipientEditPanel(body, recipients, idx, updateSummary);
            });
        });

        // Wire cancel
        body.querySelector(".svp-inv-cancel-btn")?.addEventListener("click", () => { overlay.remove(); this._setActiveMode("plan"); });

        // Wire send (includes both ready and resend rows)
        body.querySelector(".svp-inv-send-btn")?.addEventListener("click", async () => {
            const checks = body.querySelectorAll<HTMLInputElement>(".svp-inv-check:checked:not(:disabled)");
            const selectedIndices = Array.from(checks).map((c) => parseInt(c.dataset.idx ?? "-1", 10));
            const toSend = recipients.filter((_r, i) => selectedIndices.includes(i) && (_r.status === "ready" || _r.resend === true));
            await this._executeSendInvitations(toSend, body, overlay);
        });

        // Wire per-row resend buttons
        body.querySelectorAll(".svp-inv-resend-row-btn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const idx = parseInt((e.currentTarget as HTMLElement).dataset.idx ?? "-1", 10);
                if (idx < 0) return;
                const r = recipients[idx];
                r.resend = true;

                const wrapper = body.querySelector(`.svp-inv-recipient-wrapper[data-index="${idx}"]`);
                if (!wrapper) return;
                const row = wrapper.querySelector(".svp-inv-recipient") as HTMLElement;
                if (!row) return;

                const cb = row.querySelector(".svp-inv-check") as HTMLInputElement;
                if (cb) { cb.disabled = false; cb.checked = true; }

                const badge = row.querySelector(".svp-inv-badge") as HTMLElement;
                if (badge) {
                    badge.className = "svp-inv-badge svp-inv-badge-resend";
                    badge.textContent = "Resend";
                }

                (e.currentTarget as HTMLElement).style.display = "none";
                updateSummary();
            });
        });

        // Update send button count when checkboxes change; revert resend on uncheck
        body.querySelectorAll(".svp-inv-check").forEach((cb) => {
            cb.addEventListener("change", () => {
                const idx = parseInt((cb as HTMLInputElement).dataset.idx ?? "-1", 10);
                const r = idx >= 0 ? recipients[idx] : null;
                if (r && r.resend && !(cb as HTMLInputElement).checked) {
                    r.resend = false;
                    const wrapper = body.querySelector(`.svp-inv-recipient-wrapper[data-index="${idx}"]`);
                    if (wrapper) {
                        const row = wrapper.querySelector(".svp-inv-recipient") as HTMLElement;
                        const badge = row?.querySelector(".svp-inv-badge") as HTMLElement;
                        if (badge) {
                            badge.className = "svp-inv-badge svp-inv-badge-sent";
                            badge.textContent = "Already sent";
                        }
                        const resendBtn = row?.querySelector(".svp-inv-resend-row-btn") as HTMLElement;
                        if (resendBtn) resendBtn.style.display = "";
                        (cb as HTMLInputElement).disabled = true;
                    }
                }
                updateSummary();
            });
        });
    }

    private _toggleRecipientEditPanel(
        body: HTMLElement,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recipients: any[],
        idx: number,
        updateSummary: () => void
    ): void {
        const wrapper = body.querySelector(`.svp-inv-recipient-wrapper[data-index="${idx}"]`);
        if (!wrapper) return;

        // Close any other open edit panel
        body.querySelectorAll(".svp-inv-inline-edit").forEach((p) => p.remove());

        // If the panel was already open for this row, just close it
        const existing = wrapper.querySelector(".svp-inv-inline-edit");
        if (existing) {
            existing.remove();
            return;
        }

        const r = recipients[idx];
        const accountId = this._visits[r.visitIndex]?.accountId ?? "";

        const panel = document.createElement("div");
        panel.className = "svp-inv-inline-edit";
        panel.innerHTML =
            `<div class="svp-inv-ie-section">` +
            `<label class="svp-inv-ie-label">Search contact for ${this._escapeHtml(r.accountName)}</label>` +
            `<input type="text" class="svp-inv-ie-search" placeholder="Type name to search\u2026">` +
            `<div class="svp-inv-ie-results"></div>` +
            `</div>` +
            `<div class="svp-inv-ie-divider">or</div>` +
            `<div class="svp-inv-ie-section">` +
            `<label class="svp-inv-ie-label">Manually add email address</label>` +
            `<div class="svp-inv-ie-email-row">` +
            `<input type="email" class="svp-inv-ie-email" placeholder="email@example.com" value="${r.contactEmail ? this._escapeHtml(r.contactEmail) : ""}">` +
            `<button class="svp-inv-ie-apply" disabled>Apply</button>` +
            `</div>` +
            `<div class="svp-inv-ie-hint" style="display:none"></div>` +
            `</div>`;

        wrapper.appendChild(panel);

        // --- Contact search with debounce ---
        const searchInput = panel.querySelector(".svp-inv-ie-search") as HTMLInputElement;
        const resultsDiv = panel.querySelector(".svp-inv-ie-results") as HTMLElement;

        searchInput.addEventListener("input", () => {
            if (this._invContactSearchTimer) clearTimeout(this._invContactSearchTimer);
            const q = searchInput.value.trim();
            if (q.length < 2) {
                resultsDiv.innerHTML = "";
                return;
            }
            this._invContactSearchTimer = setTimeout(async () => {
                resultsDiv.innerHTML = `<div class="svp-inv-ie-searching">Searching\u2026</div>`;
                try {
                    const results = await this._searchContactsForAccount(accountId, q);
                    if (results.length === 0) {
                        resultsDiv.innerHTML = `<div class="svp-inv-ie-no-results">No contacts found</div>`;
                    } else {
                        resultsDiv.innerHTML = results.map((c) =>
                            `<div class="svp-inv-ie-result" data-cid="${c.contactid}" data-fname="${this._escapeHtml(c.firstname ?? "")}" data-fullname="${this._escapeHtml(c.fullname ?? "")}" data-email="${this._escapeHtml(c.email ?? "")}">` +
                            `<div class="svp-inv-ie-result-name">${this._escapeHtml(c.fullname ?? "(no name)")}</div>` +
                            `<div class="svp-inv-ie-result-email">${c.email ? this._escapeHtml(c.email) : "<em>no email</em>"}</div>` +
                            `</div>`
                        ).join("");
                        // Wire result clicks
                        resultsDiv.querySelectorAll(".svp-inv-ie-result").forEach((el) => {
                            el.addEventListener("click", () => {
                                const ds = (el as HTMLElement).dataset;
                                this._applyRecipientEdit(body, recipients, idx, {
                                    contactId: ds.cid ?? null,
                                    contactFirstName: ds.fname ?? "",
                                    contactFullName: ds.fullname ?? "",
                                    contactEmail: ds.email || null,
                                }, updateSummary);
                                panel.remove();
                            });
                        });
                    }
                } catch (err) {
                    console.warn("[SVP] Contact search error", err);
                    resultsDiv.innerHTML = `<div class="svp-inv-ie-no-results">Search failed</div>`;
                }
            }, 300);
        });

        // --- Email override ---
        const emailInput = panel.querySelector(".svp-inv-ie-email") as HTMLInputElement;
        const applyBtn = panel.querySelector(".svp-inv-ie-apply") as HTMLButtonElement;
        const hintDiv = panel.querySelector(".svp-inv-ie-hint") as HTMLElement;

        emailInput.addEventListener("input", () => {
            const val = emailInput.value.trim();
            const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
            applyBtn.disabled = !valid;
        });

        applyBtn.addEventListener("click", () => {
            const emailVal = emailInput.value.trim();
            this._applyRecipientEdit(body, recipients, idx, {
                contactId: r.contactId,
                contactFirstName: r.contactFirstName,
                contactFullName: r.contactFullName,
                contactEmail: emailVal,
            }, updateSummary);
            // Show hint to update D365
            if (r.contactId) {
                hintDiv.style.display = "";
                hintDiv.innerHTML = `Email applied locally. <a class="svp-inv-ie-d365link" href="#">Update in D365 \u2197</a>`;
                hintDiv.querySelector(".svp-inv-ie-d365link")?.addEventListener("click", (e) => {
                    e.preventDefault();
                    this._navigateToRecord("contact", r.contactId!);
                });
            }
            panel.remove();
        });
    }

    private async _searchContactsForAccount(
        accountId: string,
        query: string
    ): Promise<{ contactid: string; firstname: string | null; fullname: string | null; email: string | null }[]> {
        if (!this._context) return [];
        const safe = query.replace(/'/g, "''");
        let filter = `contains(fullname,'${safe}')`;
        if (accountId) {
            filter = `_parentcustomerid_value eq ${accountId} and ${filter}`;
        }
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const resp = await (this._context.webAPI as any).retrieveMultipleRecords(
                "contact",
                `?$select=contactid,firstname,fullname,emailaddress1&$filter=${filter}&$top=5&$orderby=fullname asc`
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (resp.entities ?? []).map((e: any) => ({
                contactid: e.contactid,
                firstname: e.firstname ?? null,
                fullname: e.fullname ?? null,
                email: e.emailaddress1 ?? null,
            }));
        } catch (err) {
            console.warn("[SVP] Contact search failed", err);
            return [];
        }
    }

    private _applyRecipientEdit(
        body: HTMLElement,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        recipients: any[],
        idx: number,
        update: { contactId: string | null; contactFirstName: string; contactFullName: string; contactEmail: string | null },
        updateSummary: () => void
    ): void {
        const r = recipients[idx];
        r.contactId = update.contactId;
        r.contactFirstName = update.contactFirstName;
        r.contactFullName = update.contactFullName;
        r.contactEmail = update.contactEmail;
        r.contactInitials = update.contactFullName
            ? update.contactFullName.split(" ").map((w: string) => w[0]).join("").substring(0, 2).toUpperCase()
            : r.contactInitials;

        // Update status
        if (r.status !== "already-sent") {
            r.status = update.contactEmail ? "ready" : "no-email";
        }

        // Re-render the row
        const wrapper = body.querySelector(`.svp-inv-recipient-wrapper[data-index="${idx}"]`);
        if (!wrapper) return;
        const row = wrapper.querySelector(".svp-inv-recipient") as HTMLElement;
        if (!row) return;

        // Update avatar
        const avatar = row.querySelector(".svp-inv-avatar") as HTMLElement;
        if (avatar) {
            if (!r.contactId) {
                avatar.style.background = "#F3F2F1";
                avatar.style.color = "#8A8886";
            } else {
                avatar.style.background = r.status === "ready" ? "#0078d4" : r.status === "no-email" ? "#d13438" : "#8a8886";
                avatar.style.color = "#fff";
            }
            avatar.textContent = r.contactInitials;
        }

        // Update contact line
        const contactLine = row.querySelector(".svp-inv-contact-line") as HTMLElement;
        if (contactLine) {
            let emailDisplay: string;
            if (r.contactEmail) {
                emailDisplay = this._escapeHtml(r.contactEmail);
            } else if (r.contactId) {
                emailDisplay = `<span class="svp-inv-no-contact">No email on contact</span>`;
            } else {
                emailDisplay = `<span class="svp-inv-no-contact">No primary contact \u2014 add one to enable</span>`;
            }
            contactLine.innerHTML = r.contactFullName
                ? this._escapeHtml(r.contactFullName) + " \u00B7 " + emailDisplay
                : emailDisplay;
        }

        // Update badge
        const badge = row.querySelector(".svp-inv-badge") as HTMLElement;
        if (badge) {
            if (r.status === "ready") {
                badge.className = "svp-inv-badge svp-inv-badge-ready";
                badge.textContent = "Ready";
            } else {
                badge.className = "svp-inv-badge svp-inv-badge-noemail";
                badge.textContent = "No email";
            }
        }

        // Update checkbox
        const cb = row.querySelector(".svp-inv-check") as HTMLInputElement;
        if (cb) {
            cb.disabled = r.status === "no-email";
            cb.checked = r.status === "ready";
            cb.addEventListener("change", () => updateSummary());
        }

        // Update edit button icon
        const editBtnEl = row.querySelector(".svp-inv-row-edit") as HTMLElement;
        if (editBtnEl) editBtnEl.textContent = r.contactId ? "\u270F\uFE0F" : "\u2795";

        updateSummary();
    }

    private _resolveInvitationBody(
        template: string, contactFirstName: string, oppName: string | null,
        start: Date, end: Date | null, repName: string, repTitle: string,
        repCompany: string, repPhone: string, repEmail: string
    ): string {
        const weekday = start.toLocaleDateString("en-GB", { weekday: "long" });
        const dateStr = start.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
        const startTime = start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        const endTime = end
            ? end.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : startTime;
        const durationMs = end ? (end.getTime() - start.getTime()) : 3600000;
        const durationHours = Math.round(durationMs / 3600000 * 10) / 10;

        return template
            .replace(/\[contact first name\]/gi, contactFirstName || "there")
            .replace(/\[weekday\]/gi, weekday)
            .replace(/\[date\]/gi, dateStr)
            .replace(/\[start time\]/gi, startTime)
            .replace(/\[end time\]/gi, endTime)
            .replace(/\[duration\]/gi, String(durationHours))
            .replace(/\[opportunity name\]/gi, oppName || "current projects")
            .replace(/\[rep full name\]/gi, repName)
            .replace(/\[rep job title\]/gi, repTitle || "Sales Representative")
            .replace(/\[rep company name\]/gi, repCompany || "our company")
            .replace(/\[rep phone\]/gi, repPhone || "")
            .replace(/\[rep email\]/gi, repEmail || "");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async _executeSendInvitations(toSend: any[], body: HTMLElement, overlay: HTMLElement): Promise<void> {
        if (!this._context) return;

        // Separate new sends from resends
        const newSends = toSend.filter((r) => r.status === "ready");
        const resends = toSend.filter((r) => r.resend === true);

        const sendBtn = body.querySelector(".svp-inv-send-btn") as HTMLButtonElement;
        if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.textContent = "Sending\u2026";
        }

        // Get rep details via Xrm global context
        let repName = "";
        let repTitle = "";
        let repCompany = "";
        let repPhone = "";
        let repEmail = "";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const xrm: any = (window as any).Xrm ?? (window as any).parent?.Xrm ?? (window as any).top?.Xrm;
        try {
            const gc = xrm?.Utility?.getGlobalContext?.();
            const userId = gc?.userSettings?.userId?.replace(/[{}]/g, "");
            if (userId) {
                const user = await this._context.webAPI.retrieveRecord(
                    "systemuser", userId,
                    "?$select=fullname,jobtitle,internalemailaddress,mobilephone,address1_telephone1"
                );
                repName = (user.fullname as string) ?? "";
                repTitle = (user.jobtitle as string) ?? "";
                repEmail = (user.internalemailaddress as string) ?? "";
                repPhone = (user.mobilephone as string) ?? (user.address1_telephone1 as string) ?? "";
            }
            // Try to get org name
            repCompany = gc?.organizationSettings?.organizationName ?? "";
        } catch (err) {
            console.warn("[SVP] Could not fetch rep details:", err);
        }

        let sentCount = 0;
        const resentIndices: number[] = [];
        const ctx = this._context;

        for (const r of toSend) {
            try {
                // Build personalised email content
                const subject = `Visit from ${repCompany || "our team"} \u2014 ` +
                    `${r.scheduledStart.toLocaleDateString("en-GB", { weekday: "long" })} ` +
                    `${r.scheduledStart.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}, ` +
                    `${r.scheduledStart.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` +
                    `\u2013${(r.scheduledEnd ?? r.scheduledStart).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

                const emailBody = this._resolveInvitationBody(
                    this._invitationBodyTemplate,
                    r.contactFirstName, r.opportunityName,
                    r.scheduledStart, r.scheduledEnd,
                    repName, repTitle, repCompany, repPhone, repEmail
                );

                // Create email activity
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const emailData: Record<string, any> = {
                    subject,
                    description: emailBody.replace(/\n/g, "<br>"),
                    directioncode: true, // Outgoing
                    // TODO: re-add regardingobjectid once send flow is confirmed working
                    email_activity_parties: [
                        {
                            // From: current user
                            // eslint-disable-next-line @typescript-eslint/naming-convention
                            "partyid_systemuser@odata.bind": `/systemusers(${xrm?.Utility?.getGlobalContext?.()?.userSettings?.userId?.replace(/[{}]/g, "")})`,
                            participationtypemask: 1,
                        },
                    ],
                };

                // Add "To" party (contact)
                if (r.contactId) {
                    emailData.email_activity_parties.push({
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        "partyid_contact@odata.bind": `/contacts(${r.contactId.replace(/[{}]/g, "")})`,
                        participationtypemask: 2,
                    });
                }

                console.log("[SVP] Email payload:", JSON.stringify(emailData, null, 2));
                const emailResult = await ctx.webAPI.createRecord("email", emailData);
                const emailId = (emailResult.id as string).replace(/[{}]/g, "");
                console.log("[SVP] Email created:", emailId);

                // Send the email via bound SendEmail action
                /* eslint-disable @typescript-eslint/no-explicit-any */
                const clientUrl =
                    (this._context as any)?.page?.getClientUrl?.() as string
                    || xrm?.Utility?.getGlobalContext?.()?.getClientUrl?.() as string
                    || "";
                /* eslint-enable @typescript-eslint/no-explicit-any */
                const sendResp = await fetch(
                    `${clientUrl}/api/data/v9.2/emails(${emailId})/Microsoft.Dynamics.CRM.SendEmail`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "OData-MaxVersion": "4.0",
                            "OData-Version": "4.0",
                            Accept: "application/json",
                        },
                        body: JSON.stringify({ IssueSend: true }),
                    },
                );
                console.log("[SVP] SendEmail status:", sendResp.status);
                if (!sendResp.ok) {
                    const errText = await sendResp.text();
                    console.error("[SVP] SendEmail failed:", errText);
                }

                // Update appointment invitation status to "Invited"
                const inviteUpdate: Record<string, unknown> = {};
                inviteUpdate[this._invitationStatusField] = STATUS.invitation.invited;
                await ctx.webAPI.updateRecord("appointment", r.appointmentId, inviteUpdate);

                // Update local visit
                const visit = this._visits.find((v) => v.id === r.appointmentId);
                if (visit) visit.invitationStatus = 100000001;

                if (r.resend) resentIndices.push(r.visitIndex);
                sentCount++;
            } catch (err) {
                console.error(`[SVP] Failed to send invitation for ${r.accountName}:`, err);
            }
        }

        // Update plan status
        try {
            const planStatusUpdate: Record<string, unknown> = {};
            planStatusUpdate[this._planStatusField] = STATUS.plan.completed;
            await ctx.webAPI.updateRecord(this._planTable, this._planId, planStatusUpdate);
        } catch (err) {
            console.warn("[SVP] Could not update plan status:", err);
        }

        // If only resends — show inline per-row confirmation, keep panel open
        if (newSends.length === 0 && resends.length > 0) {
            for (const r of resends) {
                r.resend = false;
                r.invitationStatus = 100000001;
                const wrapper = body.querySelector(`.svp-inv-recipient-wrapper[data-index="${r.visitIndex}"]`);
                if (!wrapper) continue;
                const row = wrapper.querySelector(".svp-inv-recipient") as HTMLElement;
                if (!row) continue;

                const badge = row.querySelector(".svp-inv-badge") as HTMLElement;
                if (badge) {
                    badge.className = "svp-inv-badge svp-inv-badge-resent";
                    badge.textContent = "\u2713 Resent";
                }

                const cb = row.querySelector(".svp-inv-check") as HTMLInputElement;
                if (cb) { cb.checked = false; cb.disabled = true; }

                const resendRowBtn = row.querySelector(".svp-inv-resend-row-btn") as HTMLElement;
                if (resendRowBtn) resendRowBtn.style.display = "";

                // Fade back to "Already sent" after 2 seconds
                setTimeout(() => {
                    if (badge) {
                        badge.className = "svp-inv-badge svp-inv-badge-sent";
                        badge.textContent = "Already sent";
                    }
                }, 2000);
            }

            // Re-enable send button
            if (sendBtn) {
                sendBtn.textContent = "Send invitations (0)";
                sendBtn.disabled = true;
            }
            return;
        }

        // Show full confirmation for new sends (possibly mixed with resends)
        body.innerHTML =
            `<div class="svp-inv-confirmation">` +
            `<div class="svp-inv-confirmation-icon">\u2709\uFE0F</div>` +
            `<div class="svp-inv-confirmation-title">${sentCount} invitation${sentCount !== 1 ? "s" : ""} sent</div>` +
            `<div class="svp-inv-confirmation-subtitle">You\u2019ll be notified when they respond.</div>` +
            `<button class="svp-inv-done-btn">Done</button>` +
            `</div>`;

        body.querySelector(".svp-inv-done-btn")?.addEventListener("click", () => {
            overlay.remove();
            this._setActiveMode("plan");
            this._renderList();
        });
    }

    /* ───────────────── DRIVE CONNECTORS ───────────────── */

    private _buildDriveConnectorHtml(
        leg: { travelTimeSeconds: number; travelTimeFormatted: string } | null
    ): string {
        if (!leg) {
            return `<div class="drive-connector">
                <div class="drive-connector-line"></div>
                <div class="drive-connector-label pending">\u2193 Drive time unknown</div>
                <div class="drive-connector-line"></div>
            </div>`;
        }
        const mins = Math.round(leg.travelTimeSeconds / 60);
        const colorClass = mins > 45 ? "drive-long" : mins > 20 ? "drive-medium" : "drive-short";
        return `<div class="drive-connector">
            <div class="drive-connector-line"></div>
            <div class="drive-connector-label ${colorClass}">\uD83D\uDE97 ${this._escapeHtml(leg.travelTimeFormatted)} drive</div>
            <div class="drive-connector-line"></div>
        </div>`;
    }

    /* ───────────────── HELPERS ───────────────── */

    private async _getFieldName(...candidates: string[]): Promise<string> {
        if (!this._context || this._visits.length === 0) return candidates[0];
        try {
            const sample = await this._context.webAPI.retrieveRecord(
                "appointment",
                this._visits[0].id,
                `?$select=${candidates.join(",")}`
            );
            for (const name of candidates) {
                if (name in sample) return name;
            }
        } catch {
            // Fall through to default
        }
        return candidates[0];
    }

    private _roundUpToHalfHour(date: Date): Date {
        const ms = date.getTime();
        const mins = date.getMinutes();
        const secs = date.getSeconds();
        const millis = date.getMilliseconds();

        // If already exactly on a half hour boundary, keep as is
        if ((mins === 0 || mins === 30) && secs === 0 && millis === 0) {
            return new Date(ms);
        }

        // Round up to next 30 min boundary
        const thirtyMin = 30 * 60 * 1000;
        const rounded = Math.ceil(ms / thirtyMin) * thirtyMin;
        return new Date(rounded);
    }

    private _formatTimeRange(start: Date, end: Date | null): string {
        const fmt = (d: Date): string =>
            d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return end ? `${fmt(start)} \u2013 ${fmt(end)}` : fmt(start);
    }

    /* ═══════════════════════════════════════════════════════════
       TERRITORY INSIGHTS — full view mode
       ═══════════════════════════════════════════════════════════ */

    private _wireTerritoryButton(): void {
        const btn = this._container.querySelector("#svp-territory-btn") as HTMLButtonElement | null;
        if (!btn) return;
        btn.addEventListener("click", () => {
            if (this._viewMode === "territoryInsights") {
                this._switchToVisitPlanView();
            } else {
                this._switchToTerritoryView();
            }
        });
    }

    private async _switchToTerritoryView(): Promise<void> {
        this._viewMode = "territoryInsights";
        this._setActiveMode("territory");

        // Close prospect search if open
        if (this._prospectPanelOpen) {
            this._closeProspectSearch();
        }

        // Update header — hide plan buttons, show back button (preserve DOM refs)
        const titleEl = this._container.querySelector(".svp-header-title") as HTMLDivElement;
        if (titleEl) titleEl.textContent = "Territory insights";
        const summaryEl = this._container.querySelector(".svp-journey-summary") as HTMLDivElement;
        if (summaryEl) summaryEl.textContent = "Accounts in your territory";

        // Hide the 4 header buttons instead of destroying them
        if (this._optimizeBtn) this._optimizeBtn.style.display = "none";
        if (this._invitationsBtn) this._invitationsBtn.style.display = "none";
        if (this._prospectBtn) this._prospectBtn.style.display = "none";
        if (this._territoryBtn) this._territoryBtn.style.display = "none";

        // Add a "Back to plan" button if not already present
        const actionsEl = this._container.querySelector(".svp-header-actions") as HTMLDivElement;
        let backBtn = actionsEl?.querySelector("#svp-territory-back-btn") as HTMLButtonElement | null;
        if (!backBtn && actionsEl) {
            backBtn = document.createElement("button");
            backBtn.className = "svp-territory-back-btn";
            backBtn.id = "svp-territory-back-btn";
            backBtn.textContent = "\u2190 Back to plan";
            actionsEl.appendChild(backBtn);
        }
        if (backBtn) backBtn.addEventListener("click", () => this._switchToVisitPlanView());

        // Ensure map panel is visible
        const mapPanel = this._container.querySelector(".svp-map-panel") as HTMLDivElement;
        if (mapPanel) mapPanel.style.display = "block";

        // Show loading
        this._listBody.innerHTML = `<div class="svp-loading">Loading territory accounts\u2026</div>`;

        // Fetch territory data
        await this._fetchTerritoryData();

        // Render territory list and map
        this._renderTerritoryList();
        this._renderTerritoryMap();
    }

    private _switchToVisitPlanView(): void {
        this._viewMode = "visitPlan";
        this._territorySelectedIds.clear();
        this._territorySearchTerm = "";
        this._territoryCityFilter = "All cities";
        if (this._territorySearchDebounce !== null) {
            window.clearTimeout(this._territorySearchDebounce);
            this._territorySearchDebounce = null;
        }

        // Remove territory map layers
        this._removeTerritoryLayers();

        // Restore header
        this._updateHeaderTitle();
        const summaryEl = this._container.querySelector(".svp-journey-summary") as HTMLDivElement;
        if (summaryEl) this._renderJourneySummary();

        // Remove "Back to plan" button and restore the original header buttons
        const backBtn = this._container.querySelector("#svp-territory-back-btn");
        if (backBtn) backBtn.remove();
        if (this._optimizeBtn) this._optimizeBtn.style.display = "";
        if (this._invitationsBtn) this._invitationsBtn.style.display = "";
        if (this._prospectBtn) this._prospectBtn.style.display = "";
        if (this._territoryBtn) this._territoryBtn.style.display = "";

        this._setActiveMode("plan");

        // Re-render the visit plan list and map
        this._renderList();
        this._renderVisitPlanPinsOnly();
    }

    /* ── Re-render visit plan map pins without recreating the map ── */
    private _renderVisitPlanPinsOnly(): void {
        if (!this._map) return;
        const map = this._map;

        // Clear existing markers
        map.markers.clear();

        // Re-add start marker
        if (this._currentPosition) {
            const startMarker = new atlas.HtmlMarker({
                position: this._currentPosition,
                color: "#107C10",
                text: "\uD83D\uDCCD",
            });
            map.markers.add(startMarker);
        }

        // Re-add numbered appointment markers
        const coords: atlas.data.Position[] = [];
        if (this._currentPosition) coords.push(this._currentPosition);
        this._visits.forEach((v, i) => {
            if (v.lat === null || v.lng === null) return;
            const position: atlas.data.Position = [v.lng, v.lat];
            coords.push(position);
            const marker = new atlas.HtmlMarker({
                position,
                text: String(i + 1),
                color: "#0078D4",
            });
            map.markers.add(marker);
        });

        if (coords.length > 0) {
            map.setCamera({
                bounds: atlas.data.BoundingBox.fromPositions(coords),
                padding: 50,
            });
        }
    }

    /* ── Fetch territory accounts and their opportunities ── */
    private async _fetchTerritoryData(scope?: "my" | "global"): Promise<void> {
        if (!this._context) return;
        const effectiveScope = scope ?? this._territoryScope;

        console.log("=== TERRITORY INSIGHTS LOAD ===", "scope:", effectiveScope);
        const userId = this._context.userSettings.userId;
        const userName = this._context.userSettings.userName;
        console.log("[SVP] Territory: user ID:", userId, "name:", userName);
        console.log("[SVP] Territory: lastVisitField config:", this._lastVisitField);

        try {
            // Build select fields — only include lastVisitField if it looks valid
            const baseFields = "name,address1_line1,address1_city,address1_latitude,address1_longitude,telephone1,accountid";
            const lastVisitCol = this._lastVisitField?.trim() || "";
            const selectFields = lastVisitCol ? `${baseFields},${lastVisitCol}` : baseFields;

            // Clean userId (strip braces for OData filter)
            const cleanUserId = userId.replace(/[{}]/g, "").toLowerCase();

            let queryFilter: string;
            let fallbackUsed = false;

            if (effectiveScope === "global") {
                queryFilter = "statecode eq 0";
                console.log("[SVP] Territory: global scope — no owner filter");
            } else {
                queryFilter = `statecode eq 0 and _ownerid_value eq ${cleanUserId}`;
                console.log("[SVP] Territory: querying with owner filter, cleanUserId:", cleanUserId);
            }

            let result;
            try {
                result = await this._context.webAPI.retrieveMultipleRecords(
                    "account",
                    `?$select=${selectFields}` +
                    `&$filter=${queryFilter}` +
                    `&$orderby=name asc` +
                    `&$top=200`
                );
                console.log("[SVP] Territory: query returned", result.entities.length, "accounts");
            } catch (queryErr) {
                console.warn("[SVP] Territory: query failed, trying without lastVisitField:", queryErr);
                result = await this._context.webAPI.retrieveMultipleRecords(
                    "account",
                    `?$select=${baseFields}` +
                    `&$filter=${queryFilter}` +
                    `&$orderby=name asc` +
                    `&$top=200`
                );
                console.log("[SVP] Territory: query (no lastVisitField) returned", result.entities.length, "accounts");
            }

            // For "my" scope: if no results, fallback to all active accounts
            if (effectiveScope === "my" && result.entities.length === 0) {
                console.warn("[SVP] Territory: no accounts owned by user, falling back to all active accounts");
                fallbackUsed = true;
                queryFilter = "statecode eq 0";
                try {
                    result = await this._context.webAPI.retrieveMultipleRecords(
                        "account",
                        `?$select=${selectFields}` +
                        `&$filter=${queryFilter}` +
                        `&$orderby=name asc` +
                        `&$top=200`
                    );
                } catch {
                    result = await this._context.webAPI.retrieveMultipleRecords(
                        "account",
                        `?$select=${baseFields}` +
                        `&$filter=${queryFilter}` +
                        `&$orderby=name asc` +
                        `&$top=200`
                    );
                }
                console.log("[SVP] Territory: fallback query returned", result.entities.length, "accounts");
            }

            this._territoryCapped = result.entities.length >= 200;

            // Log sample for debugging
            if (result.entities.length > 0) {
                console.log("[SVP] Territory: sample accounts:", result.entities.slice(0, 3).map(a => ({
                    name: a.name,
                    owner: a._ownerid_value,
                    city: a.address1_city,
                    lat: a.address1_latitude,
                    lon: a.address1_longitude,
                })));
            }

            const accounts: TerritoryAccount[] = [];
            const now = new Date();

            for (const a of result.entities) {
                const lat = a.address1_latitude as number | null;
                const lon = a.address1_longitude as number | null;
                const lastVisitRaw = lastVisitCol ? (a[lastVisitCol] as string | null) : null;
                const lastVisitDate = lastVisitRaw ? new Date(lastVisitRaw) : null;
                let daysSinceVisit: number | null = null;
                let visitCategory: TerritoryAccount["visitCategory"] = "never";

                if (lastVisitDate && !isNaN(lastVisitDate.getTime())) {
                    daysSinceVisit = Math.floor((now.getTime() - lastVisitDate.getTime()) / (1000 * 60 * 60 * 24));
                    if (daysSinceVisit > 90) visitCategory = "overdue";
                    else if (daysSinceVisit > 30) visitCategory = "due-soon";
                    else visitCategory = "recent";
                }

                accounts.push({
                    accountId: a.accountid as string,
                    name: a.name as string,
                    address: [a.address1_line1, a.address1_city].filter(Boolean).join(", ") || null,
                    city: (a.address1_city as string) || null,
                    lat,
                    lon,
                    phone: (a.telephone1 as string) || null,
                    lastVisitDate,
                    daysSinceVisit,
                    openOpportunities: 0,
                    totalPipelineValue: 0,
                    topOpportunity: null,
                    visitCategory,
                });
            }

            // Fetch open opportunities for these accounts
            if (accounts.length > 0) {
                try {
                    const oppResult = await this._context.webAPI.retrieveMultipleRecords(
                        "opportunity",
                        `?$select=name,estimatedvalue,_parentaccountid_value` +
                        `&$filter=statecode eq 0` +
                        `&$orderby=estimatedvalue desc` +
                        `&$top=500`
                    );

                    const accountMap = new Map<string, TerritoryAccount>();
                    for (const acc of accounts) accountMap.set(acc.accountId, acc);

                    for (const opp of oppResult.entities) {
                        const parentAccountId = opp._parentaccountid_value as string | null;
                        if (!parentAccountId) continue;
                        const acc = accountMap.get(parentAccountId);
                        if (!acc) continue;
                        acc.openOpportunities++;
                        acc.totalPipelineValue += (opp.estimatedvalue as number) || 0;
                        if (!acc.topOpportunity) acc.topOpportunity = opp.name as string;
                    }
                } catch (oppErr) {
                    console.warn("[SVP] Failed to fetch opportunities for territory:", oppErr);
                }
            }

            this._territoryAccounts = accounts;
            // Cache global dataset
            if (effectiveScope === "global") {
                this._territoryGlobalAccounts = accounts;
            }
            console.log(`[SVP] Territory: loaded ${accounts.length} accounts (${accounts.filter(a => a.lat != null).length} geocoded)`);

            // Show fallback notice if applicable
            if (fallbackUsed && accounts.length > 0) {
                this._showMapBanner("Showing all active accounts \u2014 no accounts assigned to you found.", "info");
            }

        } catch (err) {
            console.error("[SVP] Territory data fetch error:", err);
            this._territoryAccounts = [];
        }
    }

    /* ── Categorize visit frequency for coloring ── */
    private static _visitCategoryColor(cat: TerritoryAccount["visitCategory"]): string {
        switch (cat) {
            case "overdue": return "#d13438";   // Red
            case "due-soon": return "#ff8c00";  // Amber
            case "recent": return "#107c10";    // Green
            case "never": return "#8a8886";     // Grey
        }
    }

    private static _visitCategoryLabel(cat: TerritoryAccount["visitCategory"]): string {
        switch (cat) {
            case "overdue": return "Overdue (>90 days)";
            case "due-soon": return "Due soon (30\u201390 days)";
            case "recent": return "Recent (<30 days)";
            case "never": return "Never visited";
        }
    }

    /* ── Render territory list ── */
    private _renderTerritoryList(): void {
        const filtered = this._getFilteredTerritoryAccounts();
        const sorted = this._getSortedTerritoryAccounts(filtered);

        // Build filter chips
        const filterChips = this._buildTerritoryFilterChips();

        // Build sort dropdown
        const sortDropdown = this._buildTerritorySortDropdown();

        // Build city dropdown
        const cityDropdown = this._buildTerritoryCityDropdown();

        // --- Stats summary (reflects filtered set) ---
        const totalAccounts = this._territoryAccounts.length;
        const filteredCount = filtered.length;
        const overdueCount = filtered.filter(a => a.visitCategory === "overdue").length;
        const neverCount = filtered.filter(a => a.visitCategory === "never").length;
        const countLabel = filteredCount < totalAccounts
            ? `${filteredCount} of ${totalAccounts} accounts`
            : `${totalAccounts} accounts`;
        const scopeLabel = this._territoryScope === "global" ? "All accounts in D365" : "Accounts in your territory";

        let statsHtml = `<div class="svp-territory-stats">` +
            `<span class="svp-territory-stat">${countLabel}</span>` +
            `<span class="svp-territory-stat svp-territory-stat-warn">${overdueCount} overdue</span>` +
            `<span class="svp-territory-stat">${neverCount} never visited</span>` +
            `</div>`;

        if (this._territoryCapped) {
            statsHtml += `<div class="svp-territory-capped-note">Showing first 200 accounts. Use city filter to narrow results.</div>`;
        }

        // --- Search input ---
        const searchVal = this._escapeHtml(this._territorySearchTerm);
        const searchHtml = `<div class="svp-territory-search-wrap">` +
            `<span class="svp-territory-search-icon">\uD83D\uDD0D</span>` +
            `<input class="svp-territory-search" id="svp-territory-search" type="text" placeholder="Search city or account name\u2026" value="${searchVal}" autocomplete="off" />` +
            (this._territorySearchTerm ? `<button class="svp-territory-search-clear" id="svp-territory-search-clear">\u2715</button>` : "") +
            `</div>`;

        // --- Scope toggle + city dropdown row ---
        const myActive = this._territoryScope === "my";
        const scopeRow = `<div class="svp-territory-scope-row">` +
            `<div class="svp-territory-city-wrap">${cityDropdown}</div>` +
            `<div class="svp-territory-scope-toggle">` +
            `<button class="svp-territory-scope-btn svp-territory-scope-left${myActive ? " svp-territory-scope-active" : ""}" data-scope="my">My territory</button>` +
            `<button class="svp-territory-scope-btn svp-territory-scope-right${!myActive ? " svp-territory-scope-active" : ""}" data-scope="global">Global</button>` +
            `</div>` +
            `</div>`;

        // Toolbar (chips + sort)
        const toolbarHtml = `<div class="svp-territory-toolbar">` +
            `<div class="svp-territory-filters">${filterChips}</div>` +
            `<div class="svp-territory-sort">${sortDropdown}</div>` +
            `</div>`;

        // Build account rows
        let rowsHtml = "";
        if (sorted.length === 0) {
            rowsHtml = `<div class="svp-list-empty">No accounts match the current filter.</div>`;
        } else {
            for (const acc of sorted) {
                const isSelected = this._territorySelectedIds.has(acc.accountId);
                const dotColor = SalesVisitPlanner._visitCategoryColor(acc.visitCategory);
                const lastVisitLabel = acc.daysSinceVisit != null
                    ? `${acc.daysSinceVisit}d ago`
                    : "Never";
                const oppLabel = acc.openOpportunities > 0
                    ? `${acc.openOpportunities} opp \u00B7 ${this._formatCurrency(acc.totalPipelineValue)}`
                    : "No opportunities";

                rowsHtml += `<div class="svp-territory-row${isSelected ? " svp-territory-row-selected" : ""}" data-account-id="${this._escapeHtml(acc.accountId)}">` +
                    `<div class="svp-territory-check">` +
                    `<input type="checkbox" class="svp-territory-cb" data-account-id="${this._escapeHtml(acc.accountId)}"${isSelected ? " checked" : ""} />` +
                    `</div>` +
                    `<div class="svp-territory-dot" style="background:${dotColor}"></div>` +
                    `<div class="svp-territory-info">` +
                    `<div class="svp-territory-name">${this._escapeHtml(acc.name)}</div>` +
                    `<div class="svp-territory-meta">${this._escapeHtml(acc.address ?? "No address")} \u00B7 ${lastVisitLabel}</div>` +
                    `<div class="svp-territory-opp">${oppLabel}</div>` +
                    `</div>` +
                    `</div>`;
            }
        }

        // Bulk action bar
        const selCount = this._territorySelectedIds.size;
        const bulkBarHtml = `<div class="svp-territory-bulk${selCount > 0 ? " svp-territory-bulk-visible" : ""}">` +
            `<span class="svp-territory-bulk-count">${selCount} selected</span>` +
            `<button class="svp-territory-add-btn" id="svp-territory-add-btn">Add to plan</button>` +
            `<button class="svp-territory-clear-btn" id="svp-territory-clear-btn">Clear</button>` +
            `</div>`;

        // Update header subtitle
        const summaryEl = this._container.querySelector(".svp-journey-summary") as HTMLDivElement;
        if (summaryEl) summaryEl.textContent = scopeLabel;

        this._listBody.innerHTML = statsHtml + searchHtml + scopeRow + toolbarHtml +
            `<div class="svp-territory-list">${rowsHtml}</div>` +
            bulkBarHtml;

        this._wireTerritoryListHandlers();
    }

    private _buildTerritoryCityDropdown(): string {
        const cities = Array.from(new Set(
            this._territoryAccounts
                .map(a => a.city)
                .filter((c): c is string => !!c)
        )).sort();

        let options = `<option value="All cities"${this._territoryCityFilter === "All cities" ? " selected" : ""}>All cities</option>`;
        for (const c of cities) {
            const sel = this._territoryCityFilter === c ? " selected" : "";
            options += `<option value="${this._escapeHtml(c)}"${sel}>${this._escapeHtml(c)}</option>`;
        }
        return `<select class="svp-territory-city-select" id="svp-territory-city-select">${options}</select>`;
    }

    private _buildTerritoryFilterChips(): string {
        const filters: { key: TerritoryFilter; label: string }[] = [
            { key: "all", label: "All" },
            { key: "overdue", label: "Overdue" },
            { key: "due-soon", label: "Due soon" },
            { key: "recent", label: "Recent" },
            { key: "never", label: "Never visited" },
        ];
        return filters.map(f =>
            `<button class="svp-territory-chip${this._territoryFilter === f.key ? " svp-territory-chip-active" : ""}" data-filter="${f.key}">${f.label}</button>`
        ).join("");
    }

    private _buildTerritorySortDropdown(): string {
        return `<select class="svp-territory-sort-select" id="svp-territory-sort-select">` +
            `<option value="lastVisit"${this._territorySort === "lastVisit" ? " selected" : ""}>Last visit</option>` +
            `<option value="name"${this._territorySort === "name" ? " selected" : ""}>Name</option>` +
            `<option value="pipeline"${this._territorySort === "pipeline" ? " selected" : ""}>Pipeline value</option>` +
            `<option value="opportunities"${this._territorySort === "opportunities" ? " selected" : ""}>Opportunities</option>` +
            `</select>`;
    }

    private _getFilteredTerritoryAccounts(): TerritoryAccount[] {
        let result = [...this._territoryAccounts];

        // 1. City filter
        if (this._territoryCityFilter !== "All cities") {
            result = result.filter(a => a.city === this._territoryCityFilter);
        }

        // 2. Chip filter (visit category)
        if (this._territoryFilter !== "all") {
            result = result.filter(a => a.visitCategory === this._territoryFilter);
        }

        // 3. Text search last
        if (this._territorySearchTerm.trim()) {
            const term = this._territorySearchTerm.toLowerCase();
            result = result.filter(a =>
                a.name.toLowerCase().includes(term) ||
                (a.city && a.city.toLowerCase().includes(term)) ||
                (a.address && a.address.toLowerCase().includes(term))
            );
        }

        return result;
    }

    private _getSortedTerritoryAccounts(accounts: TerritoryAccount[]): TerritoryAccount[] {
        const sorted = [...accounts];
        switch (this._territorySort) {
            case "name":
                sorted.sort((a, b) => a.name.localeCompare(b.name));
                break;
            case "lastVisit":
                // Never visited first, then most overdue
                sorted.sort((a, b) => {
                    if (a.daysSinceVisit === null && b.daysSinceVisit === null) return a.name.localeCompare(b.name);
                    if (a.daysSinceVisit === null) return -1;
                    if (b.daysSinceVisit === null) return 1;
                    return b.daysSinceVisit - a.daysSinceVisit;
                });
                break;
            case "pipeline":
                sorted.sort((a, b) => b.totalPipelineValue - a.totalPipelineValue);
                break;
            case "opportunities":
                sorted.sort((a, b) => b.openOpportunities - a.openOpportunities);
                break;
        }
        return sorted;
    }

    private _wireTerritoryListHandlers(): void {
        // Search input with debounce
        const searchInput = this._listBody.querySelector("#svp-territory-search") as HTMLInputElement;
        if (searchInput) {
            searchInput.addEventListener("input", () => {
                if (this._territorySearchDebounce !== null) {
                    window.clearTimeout(this._territorySearchDebounce);
                }
                this._territorySearchDebounce = window.setTimeout(() => {
                    this._territorySearchTerm = searchInput.value;
                    this._renderTerritoryList();
                    this._renderTerritoryMap();
                    // Re-focus search and put cursor at end
                    const newInput = this._listBody.querySelector("#svp-territory-search") as HTMLInputElement;
                    if (newInput) { newInput.focus(); newInput.selectionStart = newInput.selectionEnd = newInput.value.length; }
                }, 200);
            });
            // Focus preservation: if search had text, keep focus
            if (this._territorySearchTerm) {
                searchInput.focus();
                searchInput.selectionStart = searchInput.selectionEnd = searchInput.value.length;
            }
        }

        // Search clear button
        const searchClear = this._listBody.querySelector("#svp-territory-search-clear");
        if (searchClear) {
            searchClear.addEventListener("click", () => {
                this._territorySearchTerm = "";
                this._renderTerritoryList();
                this._renderTerritoryMap();
            });
        }

        // City dropdown
        const citySelect = this._listBody.querySelector("#svp-territory-city-select") as HTMLSelectElement;
        if (citySelect) {
            citySelect.addEventListener("change", () => {
                this._territoryCityFilter = citySelect.value;
                this._renderTerritoryList();
                this._renderTerritoryMap();
            });
        }

        // Scope toggle buttons
        const scopeBtns = this._listBody.querySelectorAll(".svp-territory-scope-btn");
        scopeBtns.forEach(btn => {
            btn.addEventListener("click", async () => {
                const newScope = (btn as HTMLElement).dataset.scope as "my" | "global";
                if (newScope === this._territoryScope) return;
                this._territoryScope = newScope;
                // Reset filters on scope switch
                this._territoryCityFilter = "All cities";
                this._territorySearchTerm = "";

                // Show loading
                this._listBody.innerHTML = `<div class="svp-loading">Loading ${newScope === "global" ? "all" : "territory"} accounts\u2026</div>`;

                // If switching to global and we have a cached dataset, use it
                if (newScope === "global" && this._territoryGlobalAccounts) {
                    this._territoryAccounts = this._territoryGlobalAccounts;
                } else {
                    await this._fetchTerritoryData(newScope);
                }

                this._renderTerritoryList();
                this._renderTerritoryMap();
            });
        });

        // Filter chips
        const chips = this._listBody.querySelectorAll(".svp-territory-chip");
        chips.forEach(chip => {
            chip.addEventListener("click", () => {
                this._territoryFilter = (chip as HTMLElement).dataset.filter as TerritoryFilter;
                this._renderTerritoryList();
                this._renderTerritoryMap();
            });
        });

        // Sort dropdown
        const sortSelect = this._listBody.querySelector("#svp-territory-sort-select") as HTMLSelectElement;
        if (sortSelect) {
            sortSelect.addEventListener("change", () => {
                this._territorySort = sortSelect.value as TerritorySort;
                this._renderTerritoryList();
            });
        }

        // Checkboxes
        const checkboxes = this._listBody.querySelectorAll(".svp-territory-cb");
        checkboxes.forEach(cb => {
            cb.addEventListener("change", () => {
                const el = cb as HTMLInputElement;
                const accountId = el.dataset.accountId!;
                if (el.checked) {
                    this._territorySelectedIds.add(accountId);
                } else {
                    this._territorySelectedIds.delete(accountId);
                }
                this._renderTerritoryList();
            });
        });

        // Row click → highlight on map
        const rows = this._listBody.querySelectorAll(".svp-territory-row");
        rows.forEach(row => {
            row.addEventListener("click", (e) => {
                // Don't trigger on checkbox clicks
                if ((e.target as HTMLElement).classList.contains("svp-territory-cb")) return;
                const accountId = (row as HTMLElement).dataset.accountId!;
                const acc = this._territoryAccounts.find(a => a.accountId === accountId);
                if (acc && acc.lat != null && acc.lon != null && this._map) {
                    this._map.setCamera({
                        center: [acc.lon, acc.lat],
                        zoom: 14,
                        type: "ease",
                        duration: 500,
                    });
                    this._showTerritoryPopup(acc);
                }
            });
        });

        // Bulk add button
        const addBtn = this._listBody.querySelector("#svp-territory-add-btn");
        if (addBtn) {
            addBtn.addEventListener("click", () => this._addSelectedToVisitPlan());
        }

        // Clear selection button
        const clearBtn = this._listBody.querySelector("#svp-territory-clear-btn");
        if (clearBtn) {
            clearBtn.addEventListener("click", () => {
                this._territorySelectedIds.clear();
                this._renderTerritoryList();
            });
        }
    }

    /* ── Territory map rendering ── */
    private _renderTerritoryMap(): void {
        if (!this._map) return;

        // Remove existing territory layers
        this._removeTerritoryLayers();

        // Clear existing markers
        this._map.markers.clear();

        const filtered = this._getFilteredTerritoryAccounts();
        if (filtered.length === 0) return;

        // Create DataSource
        const source = new atlas.source.DataSource("territory-source");
        this._map.sources.add(source);
        this._territoryDataSource = source;

        let addedCount = 0;
        for (const acc of filtered) {
            if (acc.lat == null || acc.lon == null) continue;
            source.add(
                new atlas.data.Feature(
                    new atlas.data.Point([acc.lon, acc.lat]),
                    {
                        accountId: acc.accountId,
                        name: acc.name,
                        category: acc.visitCategory,
                        daysSinceVisit: acc.daysSinceVisit ?? -1,
                        openOpps: acc.openOpportunities,
                        pipeline: acc.totalPipelineValue,
                    }
                )
            );
            addedCount++;
        }

        if (addedCount === 0) return;

        // BubbleLayer colored by visit category
        const bubbleLayer = new atlas.layer.BubbleLayer(
            source,
            "territory-layer",
            {
                radius: 10,
                /* eslint-disable @typescript-eslint/no-explicit-any */
                color: [
                    "match",
                    ["get", "category"],
                    "overdue", "#d13438",
                    "due-soon", "#ff8c00",
                    "recent", "#107c10",
                    "never", "#8a8886",
                    "#8a8886",
                ] as any,
                /* eslint-enable @typescript-eslint/no-explicit-any */
                strokeColor: "#ffffff",
                strokeWidth: 2,
            }
        );
        this._map.layers.add(bubbleLayer);
        this._territoryLayerIds.push("territory-layer");

        // Label layer
        const labelLayer = new atlas.layer.SymbolLayer(
            source,
            "territory-labels",
            {
                iconOptions: { image: "none" },
                textOptions: {
                    textField: ["get", "name"],
                    size: 11,
                    color: "#201f1e",
                    haloColor: "#ffffff",
                    haloWidth: 2,
                    offset: [0, 1.5],
                    allowOverlap: false,
                    ignorePlacement: false,
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                filter: ["==", "$type", "Point"] as any,
            }
        );
        this._map.layers.add(labelLayer);
        this._territoryLayerIds.push("territory-labels");

        // Click handler
        this._map.events.add("click", bubbleLayer, (e: atlas.MapMouseEvent) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (!e.shapes || (e.shapes as any[]).length === 0) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const shape = (e.shapes as any[])[0];
            const props = shape instanceof atlas.Shape ? shape.getProperties() : shape.properties;
            const accountId = props?.accountId as string;
            if (accountId) {
                const acc = this._territoryAccounts.find(a => a.accountId === accountId);
                if (acc) this._showTerritoryPopup(acc);
            }
        });

        // Cursor styling
        this._map.events.add("mouseover", bubbleLayer, () => {
            this._map!.getCanvasContainer().style.cursor = "pointer";
        });
        this._map.events.add("mouseout", bubbleLayer, () => {
            this._map!.getCanvasContainer().style.cursor = "grab";
        });

        // Add legend
        this._renderTerritoryLegend();

        // Fit bounds
        const allCoords = filtered
            .filter(a => a.lat != null && a.lon != null)
            .map(a => [a.lon!, a.lat!] as atlas.data.Position);
        if (allCoords.length > 0) {
            this._map.setCamera({
                bounds: atlas.data.BoundingBox.fromPositions(allCoords),
                padding: 60,
            });
        }
    }

    /* ── Remove territory layers ── */
    private _removeTerritoryLayers(): void {
        if (!this._map) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mapAny = this._map as any;
        for (const id of this._territoryLayerIds) {
            try { mapAny.layers.remove(id); } catch { /* noop */ }
        }
        this._territoryLayerIds = [];
        if (this._territoryDataSource) {
            try { mapAny.sources.remove(this._territoryDataSource); } catch { /* noop */ }
            this._territoryDataSource = null;
        }
        if (this._territoryPopup) {
            this._territoryPopup.close();
            this._territoryPopup = null;
        }
    }

    /* ── Territory popup ── */
    private _showTerritoryPopup(acc: TerritoryAccount): void {
        if (!this._map || acc.lat == null || acc.lon == null) return;

        if (this._territoryPopup) {
            this._territoryPopup.close();
        }

        const dotColor = SalesVisitPlanner._visitCategoryColor(acc.visitCategory);
        const catLabel = SalesVisitPlanner._visitCategoryLabel(acc.visitCategory);
        const lastVisitStr = acc.lastVisitDate
            ? acc.lastVisitDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
            : "Never";
        const oppStr = acc.openOpportunities > 0
            ? `${acc.openOpportunities} open \u00B7 ${this._formatCurrency(acc.totalPipelineValue)}`
            : "No open opportunities";

        const html =
            `<div class="svp-territory-popup">` +
            `<div class="svp-territory-popup-header">` +
            `<span class="svp-territory-popup-dot" style="background:${dotColor}"></span>` +
            `<strong>${this._escapeHtml(acc.name)}</strong>` +
            `</div>` +
            `<div class="svp-territory-popup-body">` +
            `<div>${this._escapeHtml(acc.address ?? "No address")}</div>` +
            `<div>Last visit: ${lastVisitStr} <span style="color:${dotColor}">(${catLabel})</span></div>` +
            `<div>Pipeline: ${oppStr}</div>` +
            (acc.topOpportunity ? `<div>Top: ${this._escapeHtml(acc.topOpportunity)}</div>` : "") +
            `</div>` +
            `<div class="svp-territory-popup-actions">` +
            `<button class="svp-territory-popup-add" data-account-id="${this._escapeHtml(acc.accountId)}">Add to plan</button>` +
            `<button class="svp-territory-popup-open" data-account-id="${this._escapeHtml(acc.accountId)}">Open record</button>` +
            `</div>` +
            `</div>`;

        this._territoryPopup = new atlas.Popup({
            position: [acc.lon, acc.lat],
            content: html,
            pixelOffset: [0, -15],
            closeButton: true,
        });
        this._map.popups.add(this._territoryPopup);
        this._territoryPopup.open(this._map);

        // Wire popup buttons after popup renders
        setTimeout(() => {
            const addPopupBtn = document.querySelector(".svp-territory-popup-add") as HTMLButtonElement | null;
            if (addPopupBtn) {
                addPopupBtn.addEventListener("click", () => {
                    const id = addPopupBtn.dataset.accountId!;
                    this._territorySelectedIds.add(id);
                    this._addSelectedToVisitPlan();
                });
            }
            const openBtn = document.querySelector(".svp-territory-popup-open") as HTMLButtonElement | null;
            if (openBtn) {
                openBtn.addEventListener("click", () => {
                    const id = openBtn.dataset.accountId!;
                    if (this._context) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const nav = (this._context as any).navigation;
                        if (nav?.openForm) {
                            nav.openForm({
                                entityName: "account",
                                entityId: id,
                            });
                        }
                    }
                });
            }
        }, 100);
    }

    /* ── Territory map legend ── */
    private _renderTerritoryLegend(): void {
        // Remove existing legend
        const existing = this._container.querySelector(".svp-territory-legend");
        if (existing) existing.remove();

        const categories: TerritoryAccount["visitCategory"][] = ["overdue", "due-soon", "recent", "never"];
        const legendHtml = categories.map(cat => {
            const color = SalesVisitPlanner._visitCategoryColor(cat);
            const label = SalesVisitPlanner._visitCategoryLabel(cat);
            const count = this._territoryAccounts.filter(a => a.visitCategory === cat).length;
            return `<div class="svp-territory-legend-item">` +
                `<span class="svp-territory-legend-dot" style="background:${color}"></span>` +
                `<span>${label} (${count})</span>` +
                `</div>`;
        }).join("");

        const legendEl = document.createElement("div");
        legendEl.className = "svp-territory-legend";
        legendEl.innerHTML = legendHtml;

        const mapPanel = this._container.querySelector(".svp-map-panel");
        if (mapPanel) mapPanel.appendChild(legendEl);
    }

    /* ── Add selected accounts to visit plan ── */
    private async _addSelectedToVisitPlan(): Promise<void> {
        if (!this._context || this._territorySelectedIds.size === 0 || !this._planId) return;

        const selectedAccounts = this._territoryAccounts.filter(a => this._territorySelectedIds.has(a.accountId));
        if (selectedAccounts.length === 0) return;

        // Show progress
        const addBtn = this._listBody.querySelector("#svp-territory-add-btn") as HTMLButtonElement;
        if (addBtn) { addBtn.disabled = true; addBtn.textContent = "Adding\u2026"; }

        let addedCount = 0;
        const now = new Date();
        // Start appointments 30 min apart from now, rounded up
        const baseTime = this._roundUpToHalfHour(now);

        for (let i = 0; i < selectedAccounts.length; i++) {
            const acc = selectedAccounts[i];
            const startTime = new Date(baseTime.getTime() + i * 30 * 60 * 1000);
            const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);

            try {
                const territoryApptData: Record<string, unknown> = {
                    subject: `Visit \u2014 ${acc.name}`,
                    scheduledstart: startTime.toISOString(),
                    scheduledend: endTime.toISOString(),
                    location: acc.address ?? "",
                    // Link to the account as a party
                    "appointment_activity_parties": [
                        {
                            "partyid_account@odata.bind": `/accounts(${acc.accountId})`,
                            participationtypemask: 5,  // Required attendee
                        }
                    ]
                };
                // Link to the sales visit plan (regarding object)
                territoryApptData[`regardingobjectid_${this._planTable}@odata.bind`] = `/${this._planCollection}(${this._planId})`;
                await this._context.webAPI.createRecord("appointment", territoryApptData);
                addedCount++;
            } catch (err) {
                console.error(`[SVP] Failed to create appointment for ${acc.name}:`, err);
            }
        }

        // Clear selection and show confirmation
        this._territorySelectedIds.clear();
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = "Add to plan"; }

        if (addedCount > 0) {
            this._showMapBanner(
                `\u2705 Added ${addedCount} visit${addedCount > 1 ? "s" : ""} to today's plan. Switch back to see them.`,
                "info"
            );
        }

        this._renderTerritoryList();
    }

    /* ── Currency formatter ── */
    private _formatCurrency(value: number): string {
        if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
        if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
        return value.toFixed(0);
    }

    private _escapeHtml(text: string): string {
        const el = document.createElement("span");
        el.textContent = text;
        return el.innerHTML;
    }

    /* ═══════════════════════════════════════════════════════════
       FIND NEARBY PROSPECTS — map-first overlay
       ═══════════════════════════════════════════════════════════ */

    private _wireProspectButton(): void {
        const btn = this._container.querySelector("#svp-prospect-btn") as HTMLButtonElement | null;
        if (!btn) return;
        btn.addEventListener("click", () => {
            if (this._prospectPanelOpen) {
                this._closeProspectSearch();
            } else {
                this._setActiveMode("findProspects");
                this._openProspectSearch();
            }
        });
    }

    /* ── Centre point for search ── */
    private _getSearchCenter(): { lat: number; lon: number; city: string } | null {
        for (const v of this._visits) {
            if (v.lat != null && v.lng != null) {
                return { lat: v.lat, lon: v.lng, city: v.accountCity ?? "" };
            }
        }
        if (this._currentPosition) {
            return { lat: this._currentPosition[1], lon: this._currentPosition[0], city: "" };
        }
        return null;
    }

    /* ── Haversine distance (km) ── */
    private static _haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /* ── Open the map-first prospect search ── */
    private _openProspectSearch(): void {
        if (this._prospectPanelOpen) return;
        this._prospectPanelOpen = true;

        // Ensure map panel is visible
        const mapPanel = this._container.querySelector(".svp-map-panel") as HTMLDivElement;
        if (mapPanel) mapPanel.style.display = "block";

        const defaultCity = this._getDefaultProspectCity();
        console.log("[SVP] Default city resolved:", defaultCity);
        this._prospectCity = defaultCity.name;
        this._prospectCityLat = defaultCity.lat;
        this._prospectCityLon = defaultCity.lon;
        this._prospectCitySelected = !!(defaultCity.name && defaultCity.lat != null && defaultCity.lon != null);
        console.log("[SVP] City selected state:", this._prospectCitySelected,
            "lat:", this._prospectCityLat, "lon:", this._prospectCityLon);

        // Build overlay
        const overlay = document.createElement("div");
        overlay.className = "svp-ms-overlay";
        overlay.innerHTML =
            `<div class="svp-ms-bar">` +
            `<button class="svp-ms-close">\u2715</button>` +
            `<div class="svp-ms-city-ac">` +
            `<div class="svp-ms-city-pill${this._prospectCitySelected ? " svp-ms-city-confirmed" : ""}">` +
            `<span class="svp-ms-city-icon">${this._prospectCitySelected ? "\u2713" : "\uD83D\uDD0D"}</span>` +
            `<input class="svp-ms-city-input" type="text" placeholder="City\u2026" value="${this._escapeHtml(this._prospectCity)}" autocomplete="off" />` +
            `<button class="svp-ms-city-clear${this._prospectCity ? " svp-ms-city-clear-visible" : ""}">\u00D7</button>` +
            `</div>` +
            `<div class="svp-ms-city-error"></div>` +
            `<div class="svp-ms-city-dropdown"></div>` +
            `</div>` +
            `<input class="svp-ms-input" type="text" placeholder="Business type, company name\u2026" />` +
            `<button class="svp-ms-btn">\uD83D\uDD0D</button>` +
            `</div>` +
            `<div class="svp-ms-controls">` +
            `<select class="svp-ms-radius">` +
            `<option value="5">5 km</option>` +
            `<option value="10" selected>10 km</option>` +
            `<option value="20">20 km</option>` +
            `<option value="50">50 km</option>` +
            `</select>` +
            `<div class="svp-ms-mode-toggle">` +
            `<button class="svp-ms-mode-btn svp-ms-mode-btn-active" data-mode="name">By name</button>` +
            `<button class="svp-ms-mode-btn" data-mode="buyer">By buyer type</button>` +
            `</div>` +
            `<div class="svp-ms-chips">` +
            `<button class="svp-ms-chip" data-q="\uD83C\uDFD7 Roofing">\uD83C\uDFD7 Roofing</button>` +
            `<button class="svp-ms-chip" data-q="\uD83C\uDFE2 Architect">\uD83C\uDFE2 Architect</button>` +
            `<button class="svp-ms-chip" data-q="\uD83D\uDD27 Contractor">\uD83D\uDD27 Contractor</button>` +
            `<button class="svp-ms-chip" data-q="\uD83C\uDFE0 Property">\uD83C\uDFE0 Property</button>` +
            `<button class="svp-ms-chip" data-q="\u2699 Facility">\u2699 Facility</button>` +
            `</div>` +
            `</div>`;

        if (!mapPanel) return;
        mapPanel.appendChild(overlay);
        this._prospectSearchOverlay = overlay;

        // Count + legend (initially hidden)
        let countEl = mapPanel.querySelector(".svp-ms-count") as HTMLDivElement | null;
        if (!countEl) {
            countEl = document.createElement("div");
            countEl.className = "svp-ms-count";
            mapPanel.appendChild(countEl);
        }
        let legendEl = mapPanel.querySelector(".svp-ms-legend") as HTMLDivElement | null;
        if (!legendEl) {
            legendEl = document.createElement("div");
            legendEl.className = "svp-ms-legend";
            legendEl.innerHTML =
                `<span class="svp-ms-legend-item"><span class="svp-ms-dot" style="background:#0078d4"></span>Account</span>` +
                `<span class="svp-ms-legend-item"><span class="svp-ms-dot" style="background:#107c10"></span>Lead</span>` +
                `<span class="svp-ms-legend-item"><span class="svp-ms-dot" style="background:#d83b01"></span>External</span>`;
            mapPanel.appendChild(legendEl);
        }

        // If default city has name but no coords, geocode silently
        if (defaultCity.name && (defaultCity.lat == null || defaultCity.lon == null)) {
            this._geocodeCityForOverlay(defaultCity.name, overlay);
        }

        // Connectivity test — verify Azure Maps search is reachable
        this._runPOIConnectivityTest();

        // Pan map to city if coords available
        if (this._prospectCityLat != null && this._prospectCityLon != null && this._map) {
            this._map.setCamera({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...({ center: [this._prospectCityLon, this._prospectCityLat], zoom: 12, type: "ease", duration: 500 } as any),
            });
        }

        // Wire close
        overlay.querySelector(".svp-ms-close")!.addEventListener("click", () => this._closeProspectSearch());

        // Wire search
        const searchInput = overlay.querySelector(".svp-ms-input") as HTMLInputElement;
        const cityPill = overlay.querySelector(".svp-ms-city-pill") as HTMLDivElement;
        const cityError = overlay.querySelector(".svp-ms-city-error") as HTMLDivElement;
        const searchBtn = overlay.querySelector(".svp-ms-btn") as HTMLButtonElement;

        const doSearch = () => {
            if (!this._prospectCitySelected) {
                cityPill.classList.add("svp-ms-city-invalid");
                cityPill.classList.remove("svp-ms-city-confirmed");
                if (cityError) cityError.textContent = "Select a city first";
                return;
            }
            cityPill.classList.remove("svp-ms-city-invalid");
            if (cityError) cityError.textContent = "";

            const q = searchInput.value.trim();
            if (!q) return;
            this._prospectLastQuery = q;
            this._executeProspectSearch(q);
        };
        searchBtn.addEventListener("click", doSearch);
        searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

        // Wire city autocomplete
        this._wireCityAutocomplete(overlay);

        // Wire radius change
        const radiusSel = overlay.querySelector(".svp-ms-radius") as HTMLSelectElement;
        radiusSel.addEventListener("change", () => {
            this._prospectRadiusKm = parseInt(radiusSel.value, 10);
            if (this._prospectLastQuery) {
                this._executeProspectSearch(this._prospectLastQuery);
            }
        });

        // Wire mode toggle
        overlay.querySelectorAll(".svp-ms-mode-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const mode = (btn as HTMLElement).dataset.mode as ProspectSearchMode;
                if (mode === this._prospectSearchMode) return;
                this._prospectSearchMode = mode;
                overlay.querySelectorAll(".svp-ms-mode-btn").forEach((b) => b.classList.remove("svp-ms-mode-btn-active"));
                btn.classList.add("svp-ms-mode-btn-active");
                if (this._prospectLastQuery) {
                    this._executeProspectSearch(this._prospectLastQuery);
                }
            });
        });

        // Wire quick-chips
        overlay.querySelectorAll(".svp-ms-chip").forEach((chip) => {
            chip.addEventListener("click", () => {
                const q = (chip as HTMLElement).dataset.q ?? "";
                // Strip emoji prefix for the actual search query
                const cleanQ = q.replace(/^[\uD800-\uDBFF][\uDC00-\uDFFF]\s*/, "").replace(/^\u2699\s*/, "");
                searchInput.value = cleanQ;
                this._prospectLastQuery = cleanQ;
                if (this._prospectCitySelected) {
                    this._executeProspectSearch(cleanQ);
                }
            });
        });

        // Resize map when overlay appears
        if (this._map) {
            requestAnimationFrame(() => this._map!.resize());
        }
    }

    /* ── Geocode default city on overlay open when coords are missing ── */
    private async _geocodeCityForOverlay(cityName: string, overlay: HTMLElement): Promise<void> {
        console.log("[SVP] Geocoding default city:", cityName);
        if (!this._azureMapsKey) { console.warn("[SVP] No key for geocode"); return; }
        try {
            const url = `https://atlas.microsoft.com/search/address/json` +
                `?api-version=1.0` +
                `&subscription-key=${encodeURIComponent(this._azureMapsKey)}` +
                `&query=${encodeURIComponent(cityName)}` +
                `&entityType=Municipality` +
                `&countrySet=${this._geocodeCountrySet}` +
                `&language=en-US` +
                `&limit=1`;
            const resp = await fetch(url);
            if (!resp.ok) { console.error("[SVP] Geocode HTTP error:", resp.status); return; }
            const data = await resp.json();
            const first = data.results?.[0];
            if (!first?.position) { console.warn("[SVP] Geocode returned no results for:", cityName); return; }
            this._prospectCityLat = first.position.lat;
            this._prospectCityLon = first.position.lon;
            this._prospectCitySelected = true;
            console.log("[SVP] Geocode success:", cityName, "→", first.position.lat, first.position.lon);
            const pill = overlay.querySelector(".svp-ms-city-pill") as HTMLDivElement;
            if (pill) {
                pill.classList.add("svp-ms-city-confirmed");
                const icon = pill.querySelector(".svp-ms-city-icon");
                if (icon) icon.textContent = "\u2713";
            }
        } catch (err) {
            console.error("[SVP] Geocode failed for:", cityName, err);
        }
    }

    /* ── Default city from visits (nearest to now) ── */
    private _getDefaultProspectCity(): { name: string; lat: number | null; lon: number | null } {
        const now = Date.now();
        let best: VisitItem | null = null;
        let bestDiff = Infinity;
        for (const v of this._visits) {
            if (v.accountCity) {
                const diff = Math.abs(v.scheduledStart.getTime() - now);
                if (diff < bestDiff) { bestDiff = diff; best = v; }
            }
        }
        const fallback = this._visits.find((v) => v.accountCity);
        const pick = best ?? fallback ?? null;
        return {
            name: pick?.accountCity ?? "",
            lat: pick?.lat ?? null,
            lon: pick?.lng ?? null,
        };
    }

    /* ── City autocomplete (Azure Maps Municipality search) ── */
    private _wireCityAutocomplete(overlay: HTMLElement): void {
        const cityInput = overlay.querySelector(".svp-ms-city-input") as HTMLInputElement;
        const dropdown = overlay.querySelector(".svp-ms-city-dropdown") as HTMLDivElement;
        const cityPill = overlay.querySelector(".svp-ms-city-pill") as HTMLDivElement;
        const cityIcon = overlay.querySelector(".svp-ms-city-icon") as HTMLSpanElement;
        const cityError = overlay.querySelector(".svp-ms-city-error") as HTMLDivElement;
        const clearBtn = overlay.querySelector(".svp-ms-city-clear") as HTMLButtonElement;
        if (!cityInput || !dropdown || !cityPill) return;

        let debounceTimer: number | null = null;
        let highlightIndex = -1;

        const setSearchingState = () => {
            this._prospectCitySelected = false;
            this._prospectCityLat = null;
            this._prospectCityLon = null;
            cityPill.classList.remove("svp-ms-city-confirmed", "svp-ms-city-invalid");
            if (cityIcon) cityIcon.textContent = "\uD83D\uDD0D";
            if (cityError) cityError.textContent = "";
            highlightIndex = -1;
        };

        const updateClearBtn = () => {
            if (clearBtn) {
                clearBtn.classList.toggle("svp-ms-city-clear-visible", !!cityInput.value);
            }
        };

        cityInput.addEventListener("input", () => {
            setSearchingState();
            updateClearBtn();
            const val = cityInput.value.trim();
            if (debounceTimer) clearTimeout(debounceTimer);
            if (val.length < 2) { dropdown.innerHTML = ""; dropdown.style.display = "none"; return; }
            debounceTimer = window.setTimeout(() => this._fetchCitySuggestions(val, dropdown, cityInput, overlay), 300);
        });

        cityInput.addEventListener("focus", () => {
            if (dropdown.children.length > 0 && !this._prospectCitySelected) {
                dropdown.style.display = "block";
            }
        });

        if (clearBtn) {
            clearBtn.addEventListener("click", () => {
                cityInput.value = "";
                this._prospectCity = "";
                setSearchingState();
                updateClearBtn();
                dropdown.innerHTML = "";
                dropdown.style.display = "none";
                cityInput.focus();
            });
        }

        cityInput.addEventListener("keydown", (e) => {
            const items = dropdown.querySelectorAll(".svp-ms-city-item:not(.svp-ms-city-none):not(.svp-ms-city-loading)");
            if (e.key === "ArrowDown") {
                e.preventDefault();
                if (items.length === 0) return;
                highlightIndex = Math.min(highlightIndex + 1, items.length - 1);
                this._updateCityHighlight(dropdown, highlightIndex);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (items.length === 0) return;
                highlightIndex = Math.max(highlightIndex - 1, 0);
                this._updateCityHighlight(dropdown, highlightIndex);
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (highlightIndex >= 0 && highlightIndex < items.length) {
                    (items[highlightIndex] as HTMLElement).click();
                }
            } else if (e.key === "Escape") {
                dropdown.innerHTML = "";
                dropdown.style.display = "none";
                cityInput.value = "";
                this._prospectCity = "";
                setSearchingState();
                updateClearBtn();
            }
        });

        const closeHandler = (e: MouseEvent) => {
            const acWrap = overlay.querySelector(".svp-ms-city-ac") as HTMLElement;
            if (acWrap && !acWrap.contains(e.target as Node)) {
                dropdown.innerHTML = "";
                dropdown.style.display = "none";
                highlightIndex = -1;
            }
        };
        document.addEventListener("click", closeHandler, true);
        this._prospectCityCloseHandler = closeHandler;
    }

    private _updateCityHighlight(dropdown: HTMLDivElement, index: number): void {
        const items = dropdown.querySelectorAll(".svp-ms-city-item:not(.svp-ms-city-none):not(.svp-ms-city-loading)");
        items.forEach((el, i) => {
            el.classList.toggle("svp-ms-city-highlight", i === index);
        });
        const highlighted = dropdown.querySelector(".svp-ms-city-highlight") as HTMLElement;
        if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async _fetchCitySuggestions(query: string, dropdown: HTMLDivElement, cityInput: HTMLInputElement, overlay: HTMLElement): Promise<void> {
        if (!this._azureMapsKey) return;

        dropdown.innerHTML = `<div class="svp-ms-city-item svp-ms-city-loading">Searching\u2026</div>`;
        dropdown.style.display = "block";

        try {
            const url = `https://atlas.microsoft.com/search/address/json` +
                `?api-version=1.0` +
                `&subscription-key=${encodeURIComponent(this._azureMapsKey)}` +
                `&query=${encodeURIComponent(query)}` +
                `&entityType=Municipality` +
                `&countrySet=${this._geocodeCountrySet}` +
                `&language=en-US` +
                `&limit=6`;
            const resp = await fetch(url);
            if (!resp.ok) { dropdown.style.display = "none"; return; }
            const data = await resp.json();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const results: any[] = data.results ?? [];

            if (results.length === 0) {
                dropdown.innerHTML = `<div class="svp-ms-city-item svp-ms-city-none">No cities found</div>`;
                dropdown.style.display = "block";
                return;
            }

            dropdown.innerHTML = results.map((r) => {
                const name = r.address?.municipality ?? r.address?.freeformAddress ?? "";
                const country = r.address?.country ?? "";
                const lat = r.position?.lat ?? 0;
                const lon = r.position?.lon ?? 0;
                return `<div class="svp-ms-city-item" data-city="${this._escapeHtml(name)}" data-lat="${lat}" data-lon="${lon}">` +
                    `<div class="svp-ms-city-avatar">\uD83D\uDCCD</div>` +
                    `<div class="svp-ms-city-info">` +
                    `<div class="svp-ms-city-name">${this._escapeHtml(name)}</div>` +
                    (country ? `<div class="svp-ms-city-country">${this._escapeHtml(country)}</div>` : "") +
                    `</div></div>`;
            }).join("");
            dropdown.style.display = "block";

            dropdown.querySelectorAll(".svp-ms-city-item:not(.svp-ms-city-none)").forEach((item) => {
                item.addEventListener("click", () => {
                    const el = item as HTMLElement;
                    const cityName = el.dataset.city ?? "";
                    cityInput.value = cityName;
                    this._prospectCity = cityName;
                    this._prospectCityLat = parseFloat(el.dataset.lat ?? "0");
                    this._prospectCityLon = parseFloat(el.dataset.lon ?? "0");
                    this._prospectCitySelected = true;
                    console.log("[SVP] City selected from dropdown:", cityName,
                        "lat:", this._prospectCityLat, "lon:", this._prospectCityLon,
                        "valid:", !isNaN(this._prospectCityLat) && !isNaN(this._prospectCityLon) &&
                        this._prospectCityLat !== 0 && this._prospectCityLon !== 0);
                    const pill = overlay.querySelector(".svp-ms-city-pill") as HTMLDivElement;
                    if (pill) {
                        pill.classList.remove("svp-ms-city-invalid");
                        pill.classList.add("svp-ms-city-confirmed");
                        const icon = pill.querySelector(".svp-ms-city-icon");
                        if (icon) icon.textContent = "\u2713";
                    }
                    const clearB = overlay.querySelector(".svp-ms-city-clear") as HTMLButtonElement;
                    if (clearB) clearB.classList.add("svp-ms-city-clear-visible");
                    const errEl = overlay.querySelector(".svp-ms-city-error") as HTMLElement;
                    if (errEl) errEl.textContent = "";
                    dropdown.innerHTML = "";
                    dropdown.style.display = "none";
                    // Pan map to the selected city
                    if (this._map && this._prospectCityLat != null && this._prospectCityLon != null) {
                        this._map.setCamera({
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            ...({ center: [this._prospectCityLon, this._prospectCityLat], zoom: 12, type: "ease", duration: 500 } as any),
                        });
                    }
                    // Move focus to search input
                    const searchInput = overlay.querySelector(".svp-ms-input") as HTMLInputElement;
                    if (searchInput) searchInput.focus();
                });
            });
        } catch {
            dropdown.style.display = "none";
        }
    }

    /* ── Close prospect search + clean up ── */
    private _closeProspectSearch(): void {
        this._prospectPanelOpen = false;
        this._setActiveMode("plan");
        this._prospectResults = [];
        this._prospectLastQuery = "";
        this._prospectFilter = "all";
        this._prospectCity = "";
        this._prospectCityLat = null;
        this._prospectCityLon = null;
        this._prospectCitySelected = false;
        this._prospectSearchMode = "name";
        this._removeProspectPins();

        // Close popup
        if (this._prospectPopup) {
            this._prospectPopup.close();
            this._prospectPopup.remove();
            this._prospectPopup = null;
        }

        // Remove outside-click handler
        if (this._prospectCityCloseHandler) {
            document.removeEventListener("click", this._prospectCityCloseHandler, true);
            this._prospectCityCloseHandler = null;
        }

        // Remove overlay
        if (this._prospectSearchOverlay) {
            this._prospectSearchOverlay.remove();
            this._prospectSearchOverlay = null;
        }

        // Hide count + legend
        const mapPanel = this._container.querySelector(".svp-map-panel") as HTMLDivElement;
        if (mapPanel) {
            const countEl = mapPanel.querySelector(".svp-ms-count") as HTMLElement;
            if (countEl) { countEl.style.display = "none"; countEl.remove(); }
            const legendEl = mapPanel.querySelector(".svp-ms-legend") as HTMLElement;
            if (legendEl) { legendEl.style.display = "none"; legendEl.remove(); }
        }
    }

    /* ── Geocode a city name to lat/lon ── */
    private async _geocodeCity(cityName: string): Promise<{ lat: number; lon: number } | null> {
        if (!this._azureMapsKey || !cityName) return null;
        const url = `https://atlas.microsoft.com/search/address/json` +
            `?api-version=1.0` +
            `&subscription-key=${encodeURIComponent(this._azureMapsKey)}` +
            `&query=${encodeURIComponent(cityName)}` +
            `&limit=1`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        const first = data.results?.[0];
        if (!first?.position) return null;
        return { lat: first.position.lat, lon: first.position.lon };
    }

    /* ── Execute combined search — map-first ── */
    private async _executeProspectSearch(query: string): Promise<void> {
        console.log("=== [SVP] SEARCH TRIGGERED ===");
        console.log("[SVP] query:", query);
        console.log("[SVP] city state:", {
            name: this._prospectCity,
            lat: this._prospectCityLat,
            lon: this._prospectCityLon,
            selected: this._prospectCitySelected,
            mode: this._prospectSearchMode,
            radiusKm: this._prospectRadiusKm,
        });
        console.log("[SVP] azureMapsKey present:", !!this._azureMapsKey, "length:", this._azureMapsKey?.length);

        if (!this._context) { console.error("[SVP] No context — aborting"); return; }

        const cityName = this._prospectCity.trim();
        if (!cityName || !this._prospectCitySelected) {
            console.warn("[SVP] City not selected — showing warning");
            this._showMapBanner("Please select a city from the suggestions.", "warning");
            return;
        }

        // Show searching indicator on overlay
        const overlay = this._prospectSearchOverlay;
        let searchingEl: HTMLDivElement | null = null;
        if (overlay) {
            searchingEl = document.createElement("div");
            searchingEl.className = "svp-ms-searching";
            searchingEl.innerHTML = `<div class="svp-spinner"></div> Searching\u2026`;
            overlay.appendChild(searchingEl);
        }

        const centerLat = this._prospectCityLat;
        const centerLon = this._prospectCityLon;
        console.log("[SVP] centerLat:", centerLat, "centerLon:", centerLon,
            "bothNonNull:", centerLat != null && centerLon != null);

        // Center on city immediately while loading
        if (centerLat != null && centerLon != null && this._map) {
            this._map.setCamera({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...({ center: [centerLon, centerLat], zoom: 12, type: "ease", duration: 600 } as any),
            });
        }

        const radiusMeters = this._prospectRadiusKm * 1000;
        const safeCity = cityName.replace(/'/g, "''");

        try {
            const isBuyerMode = this._prospectSearchMode === "buyer";
            const hasCoords = centerLat != null && centerLon != null;
            console.log("[SVP] POI call decision:", {
                centerLatNull: centerLat == null,
                centerLonNull: centerLon == null,
                isBuyerMode,
                hasCoords,
            });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const poiState = { error: null as string | null };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let poiPromise: Promise<any[] | null>;
            if (hasCoords && this._azureMapsKey) {
                if (isBuyerMode) {
                    console.log("[SVP] Using searchByBuyerType from ProspectSearch module");
                    poiPromise = searchByBuyerType(
                        this._azureMapsKey, query, centerLat!, centerLon!, this._prospectRadiusKm
                    ).then((results) => {
                        // Convert to raw POI format expected by downstream code
                        return results.map((r) => ({
                            poi: { name: r.name, categories: r.category ? [r.category] : [], phone: r.phone, url: r.website },
                            address: { freeformAddress: r.address, municipality: r.city, streetNameAndNumber: r.address },
                            position: { lat: r.lat, lon: r.lon },
                            id: `poi-${r.name}`,
                        }));
                    }).catch((err) => {
                        console.error("[SVP] searchByBuyerType error:", err?.message, err);
                        poiState.error = err?.message ?? String(err);
                        return null;
                    });
                } else {
                    console.log("[SVP] Using searchNearbyBusinesses via _searchAzureMapsPOI");
                    poiPromise = this._searchAzureMapsPOI(query, centerLat!, centerLon!, radiusMeters)
                        .catch((err) => {
                            console.error("[SVP] Azure Maps POI error:", err?.message, err);
                            poiState.error = err?.message ?? String(err);
                            return null;
                        });
                }
            } else {
                console.warn("[SVP] POI search SKIPPED — centerLat:", centerLat, "centerLon:", centerLon, "key:", !!this._azureMapsKey);
                poiPromise = Promise.resolve(null);
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const accountPromise = isBuyerMode
                ? this._fetchProspectAccountsByBuyer(safeCity, query, centerLat ?? 0, centerLon ?? 0)
                : this._fetchProspectAccounts(safeCity, centerLat ?? 0, centerLon ?? 0);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const [accountRes, leadRes, poiRes] = await Promise.all<any>([
                accountPromise,
                this._fetchProspectLeads(safeCity, centerLat ?? 0, centerLon ?? 0),
                poiPromise,
            ]);

            const results: ProspectResult[] = [];
            const hasCenter = centerLat != null && centerLon != null;

            for (const a of accountRes) {
                if (hasCenter) {
                    const dist = (a.lat != null && a.lon != null)
                        ? SalesVisitPlanner._haversine(centerLat!, centerLon!, a.lat, a.lon)
                        : null;
                    if (dist != null && dist > this._prospectRadiusKm) continue;
                }
                results.push(a);
            }

            for (const l of leadRes) {
                if (hasCenter) {
                    const dist = (l.lat != null && l.lon != null)
                        ? SalesVisitPlanner._haversine(centerLat!, centerLon!, l.lat, l.lon)
                        : null;
                    if (dist != null && dist > this._prospectRadiusKm) continue;
                }
                results.push(l);
            }

            if (poiRes && hasCenter) {
                const d365Names = new Set(results.map((r) => r.name.toLowerCase()));
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                for (const poi of poiRes as any[]) {
                    const poiName: string = poi.poi?.name ?? "";
                    if (!poiName) continue;
                    if (d365Names.has(poiName.toLowerCase())) continue;
                    const dist = SalesVisitPlanner._haversine(centerLat!, centerLon!, poi.position.lat, poi.position.lon);
                    if (dist > this._prospectRadiusKm) continue;
                    const addr = poi.address ?? {};
                    results.push({
                        type: "external",
                        id: `poi-${poi.id ?? poiName}`,
                        name: poiName,
                        address: [addr.streetNameAndNumber, addr.municipality, addr.country].filter(Boolean).join(", "),
                        city: addr.municipality ?? "",
                        lat: poi.position.lat,
                        lon: poi.position.lon,
                        distanceKm: Math.round(dist * 10) / 10,
                        hasOpenOpportunity: false,
                        lastVisitDays: null,
                        poiAddress: addr,
                        poiName,
                    });
                }
            }

            results.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));

            this._prospectResults = results;
            this._plotProspectPins();
            this._updateProspectCount();

            if (poiRes === null && hasCenter) {
                let poiMsg = "External business search unavailable.";
                const poiError = poiState.error;
                if (poiError) {
                    if (poiError.includes("not configured")) {
                        poiMsg = "Azure Maps key not configured. Contact your administrator.";
                    } else if (poiError.includes("401")) {
                        poiMsg = "Azure Maps access denied. Check your subscription key.";
                    } else if (poiError.includes("403")) {
                        poiMsg = "Azure Maps request blocked. Check key permissions.";
                    } else if (poiError.includes("Network")) {
                        poiMsg = "Network error reaching Azure Maps. Check your connection.";
                    } else if (poiError.includes("coordinates")) {
                        poiMsg = "Invalid city location. Please re-select the city.";
                    } else {
                        poiMsg = `External search error: ${poiError}`;
                    }
                }
                this._showMapBanner(`${poiMsg} Showing D365 records only.`, "warning");
                console.warn("[SVP] POI search failed, showing D365 only. Error:", poiError);
            } else if (!hasCenter) {
                this._showMapBanner("Could not geocode city. Showing D365 records only.", "warning");
            }

        } catch (err) {
            console.error("[SVP] prospect search error:", err);
            this._showMapBanner("Search failed. Please try again.", "error");
        } finally {
            if (searchingEl) searchingEl.remove();
        }
    }

    /* ── Fetch D365 accounts near city ── */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async _fetchProspectAccounts(safeCity: string, centerLat: number, centerLon: number): Promise<ProspectResult[]> {
        if (!this._context || !safeCity) return [];
        const result = await this._context.webAPI.retrieveMultipleRecords(
            "account",
            `?$select=name,address1_line1,address1_city,address1_latitude,address1_longitude,accountid` +
            `&$filter=address1_city eq '${safeCity}'` +
            `&$top=20`
        );
        const accounts: ProspectResult[] = [];
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

        for (const a of result.entities) {
            const lat = a.address1_latitude as number | null;
            const lon = a.address1_longitude as number | null;
            const dist = (lat != null && lon != null)
                ? Math.round(SalesVisitPlanner._haversine(centerLat, centerLon, lat, lon) * 10) / 10
                : null;
            const accId = a.accountid as string;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let hasOpp = false, lastVisitDays: number | null = null;
            try {
                const [oppRes, apptRes] = await Promise.all([
                    this._context!.webAPI.retrieveMultipleRecords(
                        "opportunity",
                        `?$select=opportunityid&$filter=statecode eq 0 and _parentaccountid_value eq '${accId}'&$top=1`
                    ),
                    this._context!.webAPI.retrieveMultipleRecords(
                        "appointment",
                        `?$select=scheduledstart&$filter=_regardingobjectid_value eq '${accId}' and statecode eq 3 and scheduledstart ge ${ninetyDaysAgo}&$top=1&$orderby=scheduledstart desc`
                    ),
                ]);
                hasOpp = oppRes.entities.length > 0;
                if (apptRes.entities.length > 0) {
                    const lastDate = new Date(apptRes.entities[0].scheduledstart as string);
                    lastVisitDays = Math.floor((Date.now() - lastDate.getTime()) / (24 * 60 * 60 * 1000));
                }
            } catch { /* ignore — enrichment is optional */ }

            accounts.push({
                type: "account",
                id: accId,
                name: (a.name as string) || "Unnamed",
                address: [a.address1_line1, a.address1_city].filter(Boolean).join(", "),
                city: (a.address1_city as string) || "",
                lat, lon: lon,
                distanceKm: dist,
                hasOpenOpportunity: hasOpp,
                lastVisitDays,
            });
        }
        return accounts;
    }

    /* ── Fetch D365 accounts by buyer type (industry/description/SIC) ── */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async _fetchProspectAccountsByBuyer(safeCity: string, query: string, centerLat: number, centerLon: number): Promise<ProspectResult[]> {
        if (!this._context || !safeCity) return [];
        const safeQuery = query.replace(/'/g, "''");
        const filter = `address1_city eq '${safeCity}' and (` +
            `contains(description,'${safeQuery}') or ` +
            `contains(sic,'${safeQuery}') or ` +
            `contains(name,'${safeQuery}')` +
            `)`;
        const result = await this._context.webAPI.retrieveMultipleRecords(
            "account",
            `?$select=name,description,sic,address1_line1,address1_city,address1_latitude,address1_longitude,accountid` +
            `&$filter=${filter}` +
            `&$top=30`
        );
        const accounts: ProspectResult[] = [];
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

        for (const a of result.entities) {
            const lat = a.address1_latitude as number | null;
            const lon = a.address1_longitude as number | null;
            const dist = (lat != null && lon != null)
                ? Math.round(SalesVisitPlanner._haversine(centerLat, centerLon, lat, lon) * 10) / 10
                : null;
            const accId = a.accountid as string;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let hasOpp = false, lastVisitDays: number | null = null;
            try {
                const [oppRes, apptRes] = await Promise.all([
                    this._context!.webAPI.retrieveMultipleRecords(
                        "opportunity",
                        `?$select=opportunityid&$filter=statecode eq 0 and _parentaccountid_value eq '${accId}'&$top=1`
                    ),
                    this._context!.webAPI.retrieveMultipleRecords(
                        "appointment",
                        `?$select=scheduledstart&$filter=_regardingobjectid_value eq '${accId}' and statecode eq 3 and scheduledstart ge ${ninetyDaysAgo}&$top=1&$orderby=scheduledstart desc`
                    ),
                ]);
                hasOpp = oppRes.entities.length > 0;
                if (apptRes.entities.length > 0) {
                    const lastDate = new Date(apptRes.entities[0].scheduledstart as string);
                    lastVisitDays = Math.floor((Date.now() - lastDate.getTime()) / (24 * 60 * 60 * 1000));
                }
            } catch { /* ignore — enrichment is optional */ }

            accounts.push({
                type: "account",
                id: accId,
                name: (a.name as string) || "Unnamed",
                address: [a.address1_line1, a.address1_city].filter(Boolean).join(", "),
                city: (a.address1_city as string) || "",
                lat, lon: lon,
                distanceKm: dist,
                hasOpenOpportunity: hasOpp,
                lastVisitDays,
                isBuyerMatch: true,
            });
        }
        return accounts;
    }

    /* ── Fetch D365 leads (open) near city ── */
    private async _fetchProspectLeads(safeCity: string, centerLat: number, centerLon: number): Promise<ProspectResult[]> {
        if (!this._context || !safeCity) return [];
        const result = await this._context.webAPI.retrieveMultipleRecords(
            "lead",
            `?$select=fullname,companyname,address1_line1,address1_city,address1_latitude,address1_longitude,leadid,statecode` +
            `&$filter=statecode eq 0 and address1_city eq '${safeCity}'` +
            `&$top=20`
        );
        const leads: ProspectResult[] = [];
        for (const l of result.entities) {
            const lat = l.address1_latitude as number | null;
            const lon = l.address1_longitude as number | null;
            const dist = (lat != null && lon != null)
                ? Math.round(SalesVisitPlanner._haversine(centerLat, centerLon, lat, lon) * 10) / 10
                : null;
            leads.push({
                type: "lead",
                id: l.leadid as string,
                name: (l.companyname as string) || (l.fullname as string) || "Unnamed lead",
                address: [l.address1_line1, l.address1_city].filter(Boolean).join(", "),
                city: (l.address1_city as string) || "",
                lat, lon: lon,
                distanceKm: dist,
                hasOpenOpportunity: false,
                lastVisitDays: null,
            });
        }
        return leads;
    }

    /* ── Connectivity test — runs on search open (uses XHR via ProspectSearch module) ── */
    private async _runPOIConnectivityTest(): Promise<void> {
        console.log("[SVP-POI] Running connectivity test...");
        if (!this._azureMapsKey) {
            console.error("[SVP-POI] CONNECTIVITY TEST FAILED: No Azure Maps key");
            return;
        }
        try {
            const results = await searchNearbyBusinesses(
                this._azureMapsKey, "restaurant", 55.6761, 12.5683, 5
            );
            console.log("[SVP-POI] CONNECTIVITY TEST OK — results:", results.length);
        } catch (err) {
            console.error("[SVP-POI] CONNECTIVITY TEST FAILED:", err);
        }
    }

    /* ── Azure Maps POI fuzzy search (delegates to ProspectSearch module using XHR) ── */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async _searchAzureMapsPOI(query: string, lat: number, lon: number, radiusMeters: number): Promise<any[]> {
        console.log("[SVP-POI] _searchAzureMapsPOI called, delegating to ProspectSearch module");
        if (!this._azureMapsKey) {
            throw new Error("Azure Maps key not configured");
        }
        const radiusKm = radiusMeters / 1000;
        const results = await searchNearbyBusinesses(
            this._azureMapsKey, query, lat, lon, radiusKm
        );
        // Convert ExternalProspectResult back to raw POI format expected by _executeProspectSearch
        return results.map((r) => ({
            poi: { name: r.name, categories: r.category ? [r.category] : [], phone: r.phone, url: r.website },
            address: { freeformAddress: r.address, municipality: r.city, streetNameAndNumber: r.address },
            position: { lat: r.lat, lon: r.lon },
            id: `poi-${r.name}`,
        }));
    }

    /* ── Build popup HTML for a prospect ── */
    private _buildPopupContent(r: ProspectResult): string {
        const dotColor = r.type === "account" ? "#0078d4" : r.type === "lead" ? "#107c10" : "#d83b01";
        const typeLabel = r.type === "account" ? "Account" : r.type === "lead" ? "Lead" : "External";
        const distLabel = r.distanceKm != null ? `${r.distanceKm} km` : "City match";

        // Tags
        let tags = "";
        if (r.isBuyerMatch) {
            tags += `<span class="svp-popup-tag svp-popup-tag-buyer">Potential buyer</span>`;
        }
        if (r.type === "external") {
            tags += `<span class="svp-popup-tag svp-popup-tag-red">Not in D365</span>`;
        }
        if (r.hasOpenOpportunity) {
            tags += `<span class="svp-popup-tag svp-popup-tag-amber">Open opportunity</span>`;
        }
        if (r.type !== "external" && r.lastVisitDays === null) {
            tags += `<span class="svp-popup-tag svp-popup-tag-gray">Never visited</span>`;
        } else if (r.type !== "external" && r.lastVisitDays != null && r.lastVisitDays > 90) {
            tags += `<span class="svp-popup-tag svp-popup-tag-gray">No visit in 90 days</span>`;
        }

        // Action buttons
        let actions = "";
        if (r.type === "external") {
            actions += `<button class="svp-popup-btn svp-popup-btn-secondary" data-action="create-lead" data-prospect-id="${this._escapeHtml(r.id)}">Create lead</button>`;
            actions += `<button class="svp-popup-btn svp-popup-btn-primary" data-action="add-plan" data-prospect-id="${this._escapeHtml(r.id)}">Add to plan</button>`;
        } else {
            actions += `<button class="svp-popup-btn svp-popup-btn-primary" data-action="add-plan" data-prospect-id="${this._escapeHtml(r.id)}">Add to plan</button>`;
            const entity = r.type === "account" ? "account" : "lead";
            actions += `<a class="svp-popup-link" data-action="open" data-entity="${entity}" data-id="${this._escapeHtml(r.id)}">Open ${entity} \u2197</a>`;
        }

        // Directions link
        if (r.lat != null && r.lon != null) {
            const bingUrl = `https://www.bing.com/maps/directions?rtp=~pos.${r.lat}_${r.lon}_${encodeURIComponent(r.name)}`;
            actions += `<a class="svp-popup-link" href="${bingUrl}" target="_blank" rel="noopener">Get directions \u2197</a>`;
        }

        return `<div class="svp-popup" style="width:240px;max-width:240px;padding:12px;font-family:'Segoe UI',sans-serif;box-sizing:border-box;position:relative;">` +
            `<div class="svp-popup-header">` +
            `<div class="svp-popup-dot" style="background:${dotColor}"></div>` +
            `<div class="svp-popup-info">` +
            `<div class="svp-popup-name">${this._escapeHtml(r.name)}</div>` +
            `<div class="svp-popup-addr">${this._escapeHtml(r.address)}</div>` +
            `<div class="svp-popup-meta"><span>${distLabel}</span><span>${typeLabel}</span></div>` +
            `</div>` +
            `</div>` +
            (tags ? `<div class="svp-popup-tags">${tags}</div>` : "") +
            `<div class="svp-popup-actions">${actions}</div>` +
            `</div>`;
    }

    /* ── Show prospect popup on map ── */
    private _showProspectPopup(prospect: ProspectResult): void {
        if (!this._map || prospect.lat == null || prospect.lon == null) return;

        // Close existing popup
        if (this._prospectPopup) {
            this._prospectPopup.close();
        }

        const content = this._buildPopupContent(prospect);
        this._prospectPopup = new atlas.Popup({
            content,
            position: [prospect.lon, prospect.lat],
            pixelOffset: [0, -20],
            closeButton: true,
        });
        this._prospectPopup.open(this._map);

        // Wire action buttons inside the popup after it renders
        requestAnimationFrame(() => {
            // Popup content is added to the DOM by Azure Maps — find it via class
            const popupEls = document.querySelectorAll(".svp-popup");
            const popupEl = popupEls[popupEls.length - 1] as HTMLElement | null;
            if (!popupEl) return;

            popupEl.querySelectorAll("[data-action]").forEach((btn) => {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const action = (btn as HTMLElement).dataset.action;
                    const pid = (btn as HTMLElement).dataset.prospectId ?? "";
                    if (action === "add-plan") {
                        this._addProspectToPlan(pid);
                    } else if (action === "create-lead") {
                        this._createLeadFromProspect(pid, btn as HTMLButtonElement);
                    } else if (action === "open") {
                        this._navigateToRecord(
                            (btn as HTMLElement).dataset.entity ?? "",
                            (btn as HTMLElement).dataset.id ?? ""
                        );
                    }
                });
            });
        });
    }

    /* ── Update prospect count overlay ── */
    private _updateProspectCount(): void {
        const mapPanel = this._container.querySelector(".svp-map-panel") as HTMLDivElement;
        if (!mapPanel) return;

        const countEl = mapPanel.querySelector(".svp-ms-count") as HTMLElement;
        const legendEl = mapPanel.querySelector(".svp-ms-legend") as HTMLElement;

        if (this._prospectResults.length > 0) {
            if (countEl) {
                countEl.textContent = `${this._prospectResults.length} prospect${this._prospectResults.length === 1 ? "" : "s"} found`;
                countEl.style.display = "block";
            }
            if (legendEl) {
                legendEl.style.display = "flex";
            }
        } else {
            if (countEl) countEl.style.display = "none";
            if (legendEl) legendEl.style.display = "none";
        }
    }

    /* ── Add D365 account/lead to visit plan ── */
    private async _addProspectToPlan(prospectId: string): Promise<void> {
        if (!this._context || !this._planId) return;
        const prospect = this._prospectResults.find((r) => r.id === prospectId);
        if (!prospect) return;

        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const apptData: Record<string, any> = {
                subject: `Sales Visit \u2014 ${prospect.name}`,
                location: prospect.address,
            };
            apptData[`${this._planLookupNav}@odata.bind`] = `/${this._planCollection}(${this._planId})`;
            apptData[this._invitationStatusField] = STATUS.invitation.notSent;
            apptData[this._isPriorityField] = false;

            const lastVisit = this._visits[this._visits.length - 1];
            const startTime = lastVisit?.scheduledEnd ?? lastVisit?.scheduledStart ?? new Date();
            const start = new Date(startTime.getTime() + 30 * 60 * 1000);
            const end = new Date(start.getTime() + 60 * 60 * 1000);
            apptData.scheduledstart = start.toISOString();
            apptData.scheduledend = end.toISOString();

            if (prospect.type === "account") {
                apptData["appointment_activity_parties"] = [{
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    "partyid_account@odata.bind": `/accounts(${prospect.id})`,
                    participationtypemask: 5,
                }];
            } else if (prospect.type === "lead") {
                apptData["appointment_activity_parties"] = [{
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    "partyid_lead@odata.bind": `/leads(${prospect.id})`,
                    participationtypemask: 5,
                }];
            }

            const created = await this._context.webAPI.createRecord("appointment", apptData);
            const newId = created.id.replace(/[{}]/g, "");

            this._visits.push({
                id: newId,
                subject: apptData.subject,
                scheduledStart: start,
                scheduledEnd: end,
                location: prospect.address,
                accountName: prospect.name,
                accountId: prospect.type === "account" ? prospect.id : null,
                address: prospect.address,
                lat: prospect.lat,
                lng: prospect.lon,
                geocodeError: false,
                driveSec: null, driveMeters: null, eta: null,
                opportunityId: null, opportunityName: null,
                isPriority: false,
                invitationStatus: 100000000,
                accountCity: prospect.city,
                estimatedValue: null, salesStage: null, estimatedCloseDate: null, ownerName: null,
                regardingType: null,
                actualstart: null,
            });

            this._visits.sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());

            // Close popup after adding
            if (this._prospectPopup) this._prospectPopup.close();

            // Recalculate
            await this._geocodeAll();
            await this._calculateRoute();
            this._renderJourneySummary();
            this._plotProspectPins();
            this._updateProspectCount();

            this._showMapBanner(`Added "${this._escapeHtml(prospect.name)}" to the visit plan.`, "info");
        } catch (err) {
            console.error("[SVP] _addProspectToPlan error:", err);
            this._showMapBanner("Could not create appointment. " + String(err), "error");
        }
    }

    /* ── Create lead from external POI ── */
    private async _createLeadFromProspect(prospectId: string, btn: HTMLButtonElement): Promise<void> {
        if (!this._context) return;
        const prospect = this._prospectResults.find((r) => r.id === prospectId);
        if (!prospect || prospect.type !== "external") return;

        btn.disabled = true;
        btn.textContent = "Creating\u2026";

        try {
            const leadData = {
                subject: prospect.poiName ?? prospect.name,
                companyname: prospect.poiName ?? prospect.name,
                address1_line1: prospect.poiAddress?.streetNameAndNumber ?? "",
                address1_city: prospect.poiAddress?.municipality ?? prospect.city,
                address1_postalcode: prospect.poiAddress?.postalCode ?? "",
                address1_country: prospect.poiAddress?.country ?? "",
                address1_latitude: prospect.lat,
                address1_longitude: prospect.lon,
                leadsourcecode: 8,
            };

            const created = await this._context.webAPI.createRecord("lead", leadData);
            const newLeadId = created.id.replace(/[{}]/g, "");

            // Update prospect in cache
            prospect.leadId = newLeadId;
            prospect.type = "lead";
            prospect.id = newLeadId;

            // Refresh the popup to show updated state
            this._showProspectPopup(prospect);
            this._plotProspectPins();
            this._updateProspectCount();

            this._showMapBanner(`Lead "${this._escapeHtml(prospect.name)}" created in D365.`, "info");
        } catch (err) {
            console.error("[SVP] _createLeadFromProspect error:", err);
            btn.disabled = false;
            btn.textContent = "Create lead";
            this._showMapBanner("Could not create lead. " + String(err), "error");
        }
    }

    /* ── Map pin management ── */
    private _plotProspectPins(): void {
        console.log("[SVP] _plotProspectPins called with", this._prospectResults.length, "results");
        this._removeProspectPins();
        if (!this._map) { console.error("[SVP] _plotProspectPins: map is null"); return; }

        // Log coordinate status of each result
        for (let i = 0; i < this._prospectResults.length; i++) {
            const r = this._prospectResults[i];
            console.log(`[SVP] pin ${i}: ${r.name} | lat=${r.lat} lon=${r.lon} type=${r.type}`);
        }

        // Create DataSource for prospect pins
        const prospectSource = new atlas.source.DataSource("prospect-source");
        this._map.sources.add(prospectSource);
        this._prospectDataSource = prospectSource;

        let addedCount = 0;
        for (let i = 0; i < this._prospectResults.length; i++) {
            const r = this._prospectResults[i];
            if (r.lat == null || r.lon == null || isNaN(r.lat) || isNaN(r.lon)) {
                console.warn(`[SVP] skipping pin ${i} (${r.name}) — invalid coords`);
                continue;
            }
            const pinType = r.type === "account" ? "d365" : r.type === "lead" ? "lead" : "external";
            prospectSource.add(
                new atlas.data.Feature(
                    new atlas.data.Point([r.lon, r.lat]),
                    {
                        prospectIndex: i,
                        name: r.name,
                        type: pinType,
                    }
                )
            );
            addedCount++;
        }
        console.log("[SVP] added", addedCount, "features to prospect-source, shapes:", prospectSource.getShapes().length);

        if (addedCount === 0) {
            console.warn("[SVP] no valid coordinates to plot");
            return;
        }

        // BubbleLayer — colored circles per type
        const bubbleLayer = new atlas.layer.BubbleLayer(
            prospectSource,
            "prospect-layer",
            {
                radius: 10,
                /* eslint-disable @typescript-eslint/no-explicit-any */
                color: [
                    "match",
                    ["get", "type"],
                    "d365", "#0078d4",
                    "lead", "#107c10",
                    "external", "#d83b01",
                    "#d83b01",
                ] as any,
                /* eslint-enable @typescript-eslint/no-explicit-any */
                strokeColor: "#ffffff",
                strokeWidth: 2,
            }
        );
        this._map.layers.add(bubbleLayer);
        this._prospectLayerIds.push("prospect-layer");
        console.log("[SVP] added prospect-layer (BubbleLayer)");

        // Label layer
        const labelLayer = new atlas.layer.SymbolLayer(
            prospectSource,
            "prospect-labels",
            {
                iconOptions: { image: "none" },
                textOptions: {
                    textField: ["get", "name"],
                    size: 11,
                    color: "#201f1e",
                    haloColor: "#ffffff",
                    haloWidth: 2,
                    offset: [0, 1.5],
                    allowOverlap: false,
                    ignorePlacement: false,
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                filter: ["==", "$type", "Point"] as any,
            }
        );
        this._map.layers.add(labelLayer);
        this._prospectLayerIds.push("prospect-labels");
        console.log("[SVP] added prospect-labels (SymbolLayer)");

        // Click handler on bubble layer → show popup
        this._map.events.add("click", bubbleLayer, (e: atlas.MapMouseEvent) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (!e.shapes || (e.shapes as any[]).length === 0) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const shape = (e.shapes as any[])[0];
            const props = shape instanceof atlas.Shape ? shape.getProperties() : shape.properties;
            const idx = props?.prospectIndex as number;
            if (idx != null && idx >= 0 && idx < this._prospectResults.length) {
                this._showProspectPopup(this._prospectResults[idx]);
            }
        });

        // Cursor styling
        this._map.events.add("mouseover", bubbleLayer, () => {
            this._map!.getCanvasContainer().style.cursor = "pointer";
        });
        this._map.events.add("mouseout", bubbleLayer, () => {
            this._map!.getCanvasContainer().style.cursor = "grab";
        });

        console.log("[SVP] all prospect layers added successfully");

        // Fit map camera to prospect results only
        const prospectCoords = this._prospectResults
            .filter((r) => r.lat != null && r.lon != null && !isNaN(r.lat!) && !isNaN(r.lon!))
            .map((r) => [r.lon!, r.lat!] as [number, number]);

        if (prospectCoords.length === 1) {
            this._map.setCamera({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...({ center: prospectCoords[0], zoom: 14, type: "ease", duration: 800 } as any),
            });
        } else if (prospectCoords.length > 1) {
            this._map.setCamera({
                bounds: atlas.data.BoundingBox.fromPositions(prospectCoords),
                padding: { top: 80, bottom: 60, left: 40, right: 40 },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...({ type: "ease", duration: 800 } as any),
            });
        }
    }

    private _removeProspectPins(): void {
        if (!this._map) return;

        // Remove data-source-based layers and source
        for (const layerId of this._prospectLayerIds) {
            try {
                if (this._map.layers.getLayerById(layerId)) {
                    this._map.layers.remove(layerId);
                }
            } catch { /* layer may already be gone */ }
        }
        this._prospectLayerIds = [];

        if (this._prospectDataSource) {
            try {
                this._map.sources.remove(this._prospectDataSource);
            } catch { /* source may already be gone */ }
            this._prospectDataSource = null;
        }

        // Also clear any legacy HtmlMarkers
        this._map.markers.clear();
        this._prospectMarkers = [];

        // Re-add visit route markers
        const geoVisits = this._visits.filter((v) => v.lat != null && v.lng != null);
        for (let i = 0; i < geoVisits.length; i++) {
            const v = geoVisits[i];
            const marker = new atlas.HtmlMarker({
                position: [v.lng!, v.lat!],
                text: String(i + 1),
                color: "#0078D4",
            });
            this._map.markers.add(marker);
        }
    }
}
