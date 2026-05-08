
import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const user = pgTable("users", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull(),
    image: text("image"),
    role: text("role").default('user').notNull(),
    banned: boolean("banned").default(false).notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
});

export const session = pgTable("sessions", {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => user.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
});

export const account = pgTable("accounts", {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
});

export const verification = pgTable("verifications", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at")
});

export const manufacturer = pgTable("manufacturers", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
});

export const drugClass = pgTable("drug_classes", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
});

export const dosageForm = pgTable("dosage_forms", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
});

export const indication = pgTable("indications", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
});

export const generic = pgTable("generics", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    monographLink: text("monograph_link"),
    drugClassId: text("drug_class_id").references(() => drugClass.id),
    indicationId: text("indication_id").references(() => indication.id),
    indicationDescription: text("indication_description"),
    therapeuticClassDescription: text("therapeutic_class_description"),
    pharmacologyDescription: text("pharmacology_description"),
    dosageDescription: text("dosage_description"),
    interactionDescription: text("interaction_description"),
    contraindicationsDescription: text("contraindications_description"),
    sideEffectsDescription: text("side_effects_description"),
    pregnancyAndLactationDescription: text("pregnancy_and_lactation_description"),
    precautionsDescription: text("precautions_description"),
    pediatricUsageDescription: text("pediatric_usage_description"),
    overdoseEffectsDescription: text("overdose_effects_description"),
    administrationDescription: text("administration_description"),
    reconstitutionDescription: text("reconstitution_description"),
    storageConditionsDescription: text("storage_conditions_description"),
});

export const medicine = pgTable("medicines", {
    id: text("id").primaryKey(),
    brandName: text("brand_name").notNull(),
    type: text("type"),
    strength: text("strength").notNull(),
    genericId: text("generic_id").references(() => generic.id),
    manufacturerId: text("manufacturer_id").references(() => manufacturer.id),
    dosageFormId: text("dosage_form_id").references(() => dosageForm.id),
    packageContainer: text("package_container"),
    packageSize: text("package_size"),
    price: text("price"),
});

export const userMedication = pgTable("user_medications", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
    medicineId: text("medicine_id").references(() => medicine.id), // Optional: link to medicine if known
    medicineName: text("medicine_name").notNull(), // Allow free text if not in DB
    dosage: text("dosage"),
    frequency: text("frequency"),
    status: text("status").default('active'), // active, completed, discontinued
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull()
});

export const userActivity = pgTable("user_activities", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: 'cascade' }),
    type: text("type").notNull(), // SEARCH, SCAN, UPLOAD_REPORT
    details: text("details"), // JSON string or simple text description
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const externalMedicine = pgTable("external_medicines", {
    id: text("id").primaryKey(),
    brandName: text("brand_name").notNull(),
    genericName: text("generic_name"),
    strength: text("strength"),
    manufacturer: text("manufacturer"),
    dosageForm: text("dosage_form"),
    price: text("price"),
    packageContainer: text("package_container"),
    packageSize: text("package_size"),
    indicationDescription: text("indication_description"),
    dosageDescription: text("dosage_description"),
    source: text("source").notNull().default('MEDEX'),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const scanRecord = pgTable("scan_records", {
    id: text("id").primaryKey(),
    medicineName: text("medicine_name").notNull(),
    genericName: text("generic_name"),
    source: text("source").notNull(), // e.g. "HelloMed DB", "Medex API"
    approxLat: text("approx_lat"),
    approxLng: text("approx_lng"),
    city: text("city"),
    region: text("region"),
    country: text("country"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const invitation = pgTable("invitations", {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    role: text("role").notNull().default('pharma_rep'),
    invitedBy: text("invited_by").notNull(), // Name or Email of the superadmin
    status: text("status").notNull().default('pending'), // pending, accepted
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
});
