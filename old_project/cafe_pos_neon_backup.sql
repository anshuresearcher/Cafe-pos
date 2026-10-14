--
-- PostgreSQL database dump
--

\restrict ayPhUCE4R2DjrSetkBbqrcXmvIgvYn9xZY8MGOt6NgzWycaP729Xven5xDakAF7

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.access_profiles (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.access_profiles OWNER TO postgres;

--
-- Name: access_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.access_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.access_profiles_id_seq OWNER TO postgres;

--
-- Name: access_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.access_profiles_id_seq OWNED BY public.access_profiles.id;


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.app_settings (
    id integer NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.app_settings OWNER TO postgres;

--
-- Name: app_users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.app_users (
    id integer NOT NULL,
    display_name character varying(150) NOT NULL,
    username character varying(100) NOT NULL,
    profile_id integer,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    password_hash text,
    business_id integer
);


ALTER TABLE public.app_users OWNER TO postgres;

--
-- Name: app_users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.app_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.app_users_id_seq OWNER TO postgres;

--
-- Name: app_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.app_users_id_seq OWNED BY public.app_users.id;


--
-- Name: billing_adjustments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.billing_adjustments (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    kind character varying(20) NOT NULL,
    calculation character varying(20) NOT NULL,
    value numeric(12,2) NOT NULL,
    applies_to character varying(30) DEFAULT 'all'::character varying NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT billing_adjustments_calculation_check CHECK (((calculation)::text = ANY ((ARRAY['percent'::character varying, 'fixed'::character varying])::text[]))),
    CONSTRAINT billing_adjustments_kind_check CHECK (((kind)::text = ANY ((ARRAY['discount'::character varying, 'charge'::character varying])::text[]))),
    CONSTRAINT billing_adjustments_value_check CHECK ((value >= (0)::numeric))
);


ALTER TABLE public.billing_adjustments OWNER TO postgres;

--
-- Name: billing_adjustments_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.billing_adjustments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.billing_adjustments_id_seq OWNER TO postgres;

--
-- Name: billing_adjustments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.billing_adjustments_id_seq OWNED BY public.billing_adjustments.id;


--
-- Name: businesses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.businesses (
    id integer NOT NULL,
    business_code character varying(80) NOT NULL,
    business_name character varying(180) NOT NULL,
    password_hash text,
    profile_id integer,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    business_type character varying(80) DEFAULT 'Cafe'::character varying,
    owner_name character varying(150),
    phone character varying(40),
    email character varying(180),
    address text,
    city character varying(100),
    state character varying(100),
    gstin character varying(40),
    logo_url text,
    currency character varying(10) DEFAULT '₹'::character varying
);


ALTER TABLE public.businesses OWNER TO postgres;

--
-- Name: businesses_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.businesses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.businesses_id_seq OWNER TO postgres;

--
-- Name: businesses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.businesses_id_seq OWNED BY public.businesses.id;


--
-- Name: customers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.customers (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    phone character varying(20) NOT NULL,
    email character varying(150),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.customers OWNER TO postgres;

--
-- Name: customers_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.customers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.customers_id_seq OWNER TO postgres;

--
-- Name: customers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.customers_id_seq OWNED BY public.customers.id;


--
-- Name: expense_categories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.expense_categories (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.expense_categories OWNER TO postgres;

--
-- Name: expense_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.expense_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.expense_categories_id_seq OWNER TO postgres;

--
-- Name: expense_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.expense_categories_id_seq OWNED BY public.expense_categories.id;


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.expenses (
    id integer NOT NULL,
    category_id integer,
    amount numeric(12,2) NOT NULL,
    payment_method character varying(50) DEFAULT 'Cash'::character varying NOT NULL,
    expense_date date DEFAULT CURRENT_DATE NOT NULL,
    note text,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT expenses_amount_check CHECK ((amount >= (0)::numeric))
);


ALTER TABLE public.expenses OWNER TO postgres;

--
-- Name: expenses_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.expenses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.expenses_id_seq OWNER TO postgres;

--
-- Name: expenses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.expenses_id_seq OWNED BY public.expenses.id;


--
-- Name: invoice_number_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.invoice_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.invoice_number_seq OWNER TO postgres;

--
-- Name: invoices; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.invoices (
    id integer NOT NULL,
    invoice_number character varying(50) NOT NULL,
    order_id integer NOT NULL,
    customer_id integer,
    invoice_date timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    gst numeric(12,2) DEFAULT 0 NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    payment_method character varying(50),
    status character varying(30) DEFAULT 'Generated'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.invoices OWNER TO postgres;

--
-- Name: invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.invoices_id_seq OWNER TO postgres;

--
-- Name: invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;


--
-- Name: kot; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.kot (
    id integer NOT NULL,
    order_id integer NOT NULL,
    item_name character varying(100) NOT NULL,
    quantity integer NOT NULL,
    status character varying(30) DEFAULT 'Pending'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    kot_group_id integer
);


ALTER TABLE public.kot OWNER TO postgres;

--
-- Name: kot_groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.kot_groups (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    description text,
    station character varying(60) DEFAULT 'Kitchen'::character varying NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.kot_groups OWNER TO postgres;

--
-- Name: kot_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.kot_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.kot_groups_id_seq OWNER TO postgres;

--
-- Name: kot_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.kot_groups_id_seq OWNED BY public.kot_groups.id;


--
-- Name: kot_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.kot_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.kot_id_seq OWNER TO postgres;

--
-- Name: kot_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.kot_id_seq OWNED BY public.kot.id;


--
-- Name: loyalty_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.loyalty_settings (
    id integer NOT NULL,
    points_per_currency numeric(10,4) DEFAULT 1 NOT NULL,
    currency_per_point numeric(10,4) DEFAULT 1 NOT NULL,
    min_redeem_points integer DEFAULT 100 NOT NULL,
    welcome_points integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT loyalty_settings_id_check CHECK ((id = 1))
);


ALTER TABLE public.loyalty_settings OWNER TO postgres;

--
-- Name: loyalty_transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.loyalty_transactions (
    id integer NOT NULL,
    customer_id integer NOT NULL,
    points integer NOT NULL,
    transaction_type character varying(40) NOT NULL,
    reference_type character varying(40),
    reference_id integer,
    note text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.loyalty_transactions OWNER TO postgres;

--
-- Name: loyalty_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.loyalty_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.loyalty_transactions_id_seq OWNER TO postgres;

--
-- Name: loyalty_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.loyalty_transactions_id_seq OWNED BY public.loyalty_transactions.id;


--
-- Name: menu; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.menu (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    price numeric(10,2) NOT NULL,
    category character varying(50) NOT NULL,
    available boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    kot_group_id integer,
    nature character varying(20) DEFAULT 'Goods'::character varying NOT NULL,
    unit character varying(20) DEFAULT 'ea'::character varying NOT NULL,
    tax_rate numeric(6,2) DEFAULT 5 NOT NULL,
    cgst_rate numeric(6,2) DEFAULT 2.5 NOT NULL,
    sgst_rate numeric(6,2) DEFAULT 2.5 NOT NULL,
    igst_rate numeric(6,2) DEFAULT 5 NOT NULL,
    tax_mode character varying(20) DEFAULT 'exclusive'::character varying NOT NULL,
    tax_label character varying(60) DEFAULT 'GST 5%'::character varying NOT NULL,
    channel_prices jsonb DEFAULT '{}'::jsonb NOT NULL,
    category_id integer,
    image_url text
);


ALTER TABLE public.menu OWNER TO postgres;

--
-- Name: menu_categories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.menu_categories (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    icon character varying(20) DEFAULT '•'::character varying NOT NULL,
    active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.menu_categories OWNER TO postgres;

--
-- Name: menu_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.menu_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.menu_categories_id_seq OWNER TO postgres;

--
-- Name: menu_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.menu_categories_id_seq OWNED BY public.menu_categories.id;


--
-- Name: menu_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.menu_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.menu_id_seq OWNER TO postgres;

--
-- Name: menu_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.menu_id_seq OWNED BY public.menu.id;


--
-- Name: menu_variants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.menu_variants (
    id integer NOT NULL,
    menu_id integer NOT NULL,
    name character varying(120) NOT NULL,
    sku character varying(80),
    price numeric(12,2) DEFAULT 0 NOT NULL,
    unit character varying(20) DEFAULT 'ea'::character varying NOT NULL,
    channel_prices jsonb DEFAULT '{}'::jsonb NOT NULL,
    available boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.menu_variants OWNER TO postgres;

--
-- Name: menu_variants_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.menu_variants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.menu_variants_id_seq OWNER TO postgres;

--
-- Name: menu_variants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.menu_variants_id_seq OWNED BY public.menu_variants.id;


--
-- Name: order_adjustment_audit; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.order_adjustment_audit (
    id integer NOT NULL,
    order_id integer NOT NULL,
    changed_by integer,
    change_type character varying(50) NOT NULL,
    old_discount numeric(12,2) DEFAULT 0 NOT NULL,
    new_discount numeric(12,2) DEFAULT 0 NOT NULL,
    old_service_charge numeric(12,2) DEFAULT 0 NOT NULL,
    new_service_charge numeric(12,2) DEFAULT 0 NOT NULL,
    reason text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.order_adjustment_audit OWNER TO postgres;

--
-- Name: order_adjustment_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.order_adjustment_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.order_adjustment_audit_id_seq OWNER TO postgres;

--
-- Name: order_adjustment_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.order_adjustment_audit_id_seq OWNED BY public.order_adjustment_audit.id;


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.order_items (
    id integer NOT NULL,
    order_id integer NOT NULL,
    menu_id integer,
    item_name character varying(100) NOT NULL,
    price numeric(10,2) NOT NULL,
    quantity integer NOT NULL,
    line_total numeric(10,2) NOT NULL,
    variant_id integer,
    unit character varying(20),
    tax_rate numeric(6,2) DEFAULT 5 NOT NULL,
    tax_mode character varying(20) DEFAULT 'exclusive'::character varying NOT NULL
);


ALTER TABLE public.order_items OWNER TO postgres;

--
-- Name: order_items_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.order_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.order_items_id_seq OWNER TO postgres;

--
-- Name: order_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.order_items_id_seq OWNED BY public.order_items.id;


--
-- Name: orders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.orders (
    id integer NOT NULL,
    order_number character varying(50) NOT NULL,
    order_type character varying(20) NOT NULL,
    table_number character varying(20),
    subtotal numeric(10,2) NOT NULL,
    gst numeric(10,2) NOT NULL,
    total numeric(10,2) NOT NULL,
    payment_method character varying(30),
    status character varying(30) DEFAULT 'Pending'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    customer_id integer,
    discount numeric(12,2) DEFAULT 0 NOT NULL,
    service_charge numeric(12,2) DEFAULT 0 NOT NULL,
    notes text,
    adjustment_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    discount_adjustment_id integer,
    charge_adjustment_id integer
);


ALTER TABLE public.orders OWNER TO postgres;

--
-- Name: orders_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.orders_id_seq OWNER TO postgres;

--
-- Name: orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;


--
-- Name: payments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.payments (
    id integer NOT NULL,
    order_id integer NOT NULL,
    order_number character varying(50) NOT NULL,
    amount numeric(10,2) NOT NULL,
    payment_method character varying(30) NOT NULL,
    payment_status character varying(30) DEFAULT 'Paid'::character varying,
    transaction_id character varying(100),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.payments OWNER TO postgres;

--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.payments_id_seq OWNER TO postgres;

--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;


--
-- Name: reservations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.reservations (
    id integer NOT NULL,
    customer_name character varying(100) NOT NULL,
    phone character varying(20) NOT NULL,
    reservation_date date NOT NULL,
    reservation_time time without time zone NOT NULL,
    guests integer NOT NULL,
    table_number character varying(20),
    status character varying(30) DEFAULT 'Reserved'::character varying,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.reservations OWNER TO postgres;

--
-- Name: reservations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.reservations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.reservations_id_seq OWNER TO postgres;

--
-- Name: reservations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.reservations_id_seq OWNED BY public.reservations.id;


--
-- Name: restaurant_tables; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.restaurant_tables (
    id integer NOT NULL,
    table_number character varying(20) NOT NULL,
    capacity integer DEFAULT 4 NOT NULL,
    status character varying(20) DEFAULT 'Available'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.restaurant_tables OWNER TO postgres;

--
-- Name: restaurant_tables_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.restaurant_tables_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.restaurant_tables_id_seq OWNER TO postgres;

--
-- Name: restaurant_tables_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.restaurant_tables_id_seq OWNED BY public.restaurant_tables.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    username character varying(50) NOT NULL,
    password character varying(255) NOT NULL,
    role character varying(20) DEFAULT 'cashier'::character varying NOT NULL,
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO postgres;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: access_profiles id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.access_profiles ALTER COLUMN id SET DEFAULT nextval('public.access_profiles_id_seq'::regclass);


--
-- Name: app_users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_users ALTER COLUMN id SET DEFAULT nextval('public.app_users_id_seq'::regclass);


--
-- Name: billing_adjustments id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.billing_adjustments ALTER COLUMN id SET DEFAULT nextval('public.billing_adjustments_id_seq'::regclass);


--
-- Name: businesses id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.businesses ALTER COLUMN id SET DEFAULT nextval('public.businesses_id_seq'::regclass);


--
-- Name: customers id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);


--
-- Name: expense_categories id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_categories ALTER COLUMN id SET DEFAULT nextval('public.expense_categories_id_seq'::regclass);


--
-- Name: expenses id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses ALTER COLUMN id SET DEFAULT nextval('public.expenses_id_seq'::regclass);


--
-- Name: invoices id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);


--
-- Name: kot id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.kot ALTER COLUMN id SET DEFAULT nextval('public.kot_id_seq'::regclass);


--
-- Name: kot_groups id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.kot_groups ALTER COLUMN id SET DEFAULT nextval('public.kot_groups_id_seq'::regclass);


--
-- Name: loyalty_transactions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.loyalty_transactions ALTER COLUMN id SET DEFAULT nextval('public.loyalty_transactions_id_seq'::regclass);


--
-- Name: menu id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu ALTER COLUMN id SET DEFAULT nextval('public.menu_id_seq'::regclass);


--
-- Name: menu_categories id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu_categories ALTER COLUMN id SET DEFAULT nextval('public.menu_categories_id_seq'::regclass);


--
-- Name: menu_variants id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu_variants ALTER COLUMN id SET DEFAULT nextval('public.menu_variants_id_seq'::regclass);


--
-- Name: order_adjustment_audit id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_adjustment_audit ALTER COLUMN id SET DEFAULT nextval('public.order_adjustment_audit_id_seq'::regclass);


--
-- Name: order_items id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_items ALTER COLUMN id SET DEFAULT nextval('public.order_items_id_seq'::regclass);


--
-- Name: orders id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.payments ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq'::regclass);


--
-- Name: reservations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.reservations ALTER COLUMN id SET DEFAULT nextval('public.reservations_id_seq'::regclass);


--
-- Name: restaurant_tables id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.restaurant_tables ALTER COLUMN id SET DEFAULT nextval('public.restaurant_tables_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: access_profiles; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.access_profiles (id, name, description, permissions, created_at, updated_at) FROM stdin;
3	Cashier	Counter and cashier access	{"menu.edit": false, "menu.view": true, "menu.print": false, "access.edit": false, "access.view": false, "backup.edit": false, "backup.view": false, "menu.create": false, "menu.delete": false, "menu.export": false, "orders.edit": false, "orders.view": true, "tables.edit": false, "tables.view": true, "access.print": false, "backup.print": false, "kitchen.edit": false, "kitchen.view": true, "loyalty.edit": false, "loyalty.view": false, "orders.print": false, "reports.edit": false, "reports.view": false, "tables.print": false, "access.create": false, "access.delete": false, "access.export": false, "backup.create": false, "backup.delete": false, "backup.export": false, "expenses.edit": false, "expenses.view": false, "kitchen.print": true, "loyalty.print": false, "orders.create": false, "orders.delete": false, "orders.export": false, "payments.edit": false, "payments.view": true, "reports.print": false, "settings.edit": false, "settings.view": false, "tables.create": false, "tables.delete": false, "tables.export": false, "customers.edit": false, "customers.view": true, "dashboard.edit": false, "dashboard.view": true, "expenses.print": false, "kitchen.create": false, "kitchen.delete": false, "kitchen.export": false, "loyalty.create": false, "loyalty.delete": false, "loyalty.export": false, "new_order.edit": false, "new_order.view": true, "payments.print": false, "reports.create": false, "reports.delete": false, "reports.export": false, "settings.print": false, "customers.print": false, "dashboard.print": false, "deployment.edit": false, "deployment.view": false, "expenses.create": false, "expenses.delete": false, "expenses.export": false, "kot_groups.edit": false, "kot_groups.view": true, "new_order.print": false, "payments.create": true, "payments.delete": false, "payments.export": false, "settings.create": false, "settings.delete": false, "settings.export": false, "customers.create": true, "customers.delete": false, "customers.export": false, "dashboard.create": false, "dashboard.delete": false, "dashboard.export": false, "deployment.print": false, "kot_groups.print": false, "new_order.create": true, "new_order.delete": false, "new_order.export": false, "deployment.create": false, "deployment.delete": false, "deployment.export": false, "kot_groups.create": false, "kot_groups.delete": false, "kot_groups.export": false, "reservations.edit": false, "reservations.view": false, "reservations.print": false, "reservations.create": true, "reservations.delete": false, "reservations.export": false, "advanced_reports.edit": false, "advanced_reports.view": false, "invoice_designer.edit": false, "invoice_designer.view": false, "advanced_reports.print": false, "invoice_designer.print": false, "advanced_reports.create": false, "advanced_reports.delete": false, "advanced_reports.export": false, "invoice_designer.create": false, "invoice_designer.delete": false, "invoice_designer.export": false}	2026-09-09 20:20:04.198776	2026-09-10 10:39:28.572476
1	Admin	Full system access	{"menu.edit": true, "menu.view": true, "menu.print": true, "access.edit": true, "access.view": true, "backup.edit": true, "backup.view": true, "menu.create": true, "menu.delete": true, "menu.export": true, "orders.edit": true, "orders.view": true, "tables.edit": true, "tables.view": true, "access.print": true, "backup.print": true, "kitchen.edit": true, "kitchen.view": true, "loyalty.edit": true, "loyalty.view": true, "menu.reprint": false, "orders.print": true, "reports.edit": true, "reports.view": true, "tables.print": true, "access.create": true, "access.delete": true, "access.export": true, "backup.create": true, "backup.delete": true, "backup.export": true, "expenses.edit": true, "expenses.view": true, "kitchen.print": true, "loyalty.print": true, "orders.create": true, "orders.delete": true, "orders.export": true, "payments.edit": true, "payments.view": true, "reports.print": true, "settings.edit": true, "settings.view": true, "tables.create": true, "tables.delete": true, "tables.export": true, "access.reprint": false, "backup.reprint": false, "customers.edit": true, "customers.view": true, "dashboard.edit": true, "dashboard.view": true, "expenses.print": true, "kitchen.create": true, "kitchen.delete": true, "kitchen.export": true, "loyalty.create": true, "loyalty.delete": true, "loyalty.export": true, "new_order.edit": true, "new_order.view": true, "orders.reprint": false, "payments.print": true, "reports.create": true, "reports.delete": true, "reports.export": true, "settings.print": true, "tables.reprint": false, "customers.print": true, "dashboard.print": true, "deployment.edit": true, "deployment.view": true, "expenses.create": true, "expenses.delete": true, "expenses.export": true, "kitchen.reprint": false, "kot_groups.edit": false, "kot_groups.view": false, "loyalty.reprint": false, "new_order.print": true, "payments.create": true, "payments.delete": true, "payments.export": true, "reports.reprint": false, "settings.create": true, "settings.delete": true, "settings.export": true, "customers.create": true, "customers.delete": true, "customers.export": true, "dashboard.create": true, "dashboard.delete": true, "dashboard.export": true, "deployment.print": true, "expenses.reprint": false, "kot_groups.print": false, "menu.edit_closed": false, "menu.reprint_kot": false, "new_order.create": true, "new_order.delete": true, "new_order.export": true, "payments.reprint": false, "settings.reprint": false, "customers.reprint": false, "dashboard.reprint": false, "deployment.create": true, "deployment.delete": true, "deployment.export": true, "kot_groups.create": false, "kot_groups.delete": false, "kot_groups.export": false, "new_order.reprint": false, "reservations.edit": true, "reservations.view": true, "access.edit_closed": false, "access.reprint_kot": false, "backup.edit_closed": false, "backup.reprint_kot": false, "deployment.reprint": true, "kot_groups.reprint": false, "orders.edit_closed": false, "orders.reprint_kot": false, "reservations.print": true, "tables.edit_closed": false, "tables.reprint_kot": false, "kitchen.edit_closed": false, "kitchen.reprint_kot": false, "loyalty.edit_closed": false, "loyalty.reprint_kot": false, "reports.edit_closed": false, "reports.reprint_kot": false, "reservations.create": true, "reservations.delete": true, "reservations.export": true, "expenses.edit_closed": false, "expenses.reprint_kot": false, "payments.edit_closed": false, "payments.reprint_kot": false, "reservations.reprint": false, "settings.edit_closed": false, "settings.reprint_kot": false, "advanced_reports.edit": true, "advanced_reports.view": true, "customers.edit_closed": false, "customers.reprint_kot": false, "dashboard.edit_closed": false, "dashboard.reprint_kot": false, "invoice_designer.edit": true, "invoice_designer.view": true, "new_order.edit_closed": false, "new_order.reprint_kot": false, "advanced_reports.print": true, "deployment.edit_closed": true, "deployment.reprint_kot": true, "invoice_designer.print": true, "kot_groups.edit_closed": false, "kot_groups.reprint_kot": false, "advanced_reports.create": true, "advanced_reports.delete": true, "advanced_reports.export": true, "invoice_designer.create": true, "invoice_designer.delete": true, "invoice_designer.export": true, "advanced_reports.reprint": true, "invoice_designer.reprint": true, "reservations.edit_closed": false, "reservations.reprint_kot": false, "advanced_reports.edit_closed": true, "advanced_reports.reprint_kot": true, "invoice_designer.edit_closed": true, "invoice_designer.reprint_kot": true, "menu.manage_adjustments_closed": false, "access.manage_adjustments_closed": false, "backup.manage_adjustments_closed": false, "orders.manage_adjustments_closed": false, "tables.manage_adjustments_closed": false, "kitchen.manage_adjustments_closed": false, "loyalty.manage_adjustments_closed": false, "reports.manage_adjustments_closed": false, "expenses.manage_adjustments_closed": false, "payments.manage_adjustments_closed": false, "settings.manage_adjustments_closed": false, "customers.manage_adjustments_closed": false, "dashboard.manage_adjustments_closed": false, "new_order.manage_adjustments_closed": false, "deployment.manage_adjustments_closed": true, "kot_groups.manage_adjustments_closed": false, "reservations.manage_adjustments_closed": false, "advanced_reports.manage_adjustments_closed": true, "invoice_designer.manage_adjustments_closed": true}	2026-09-09 19:54:39.478013	2026-09-10 10:39:28.572476
2	Manager	Operational access without full administration	{"menu.edit": true, "menu.view": true, "menu.print": false, "access.edit": false, "access.view": false, "menu.create": true, "menu.delete": false, "menu.export": false, "orders.edit": false, "orders.view": true, "tables.edit": true, "tables.view": true, "access.print": false, "kitchen.edit": true, "kitchen.view": true, "orders.print": true, "reports.edit": false, "reports.view": true, "tables.print": false, "access.create": false, "access.delete": false, "access.export": false, "kitchen.print": true, "orders.create": false, "orders.delete": false, "orders.export": false, "payments.edit": false, "payments.view": true, "reports.print": false, "settings.edit": false, "settings.view": false, "tables.create": false, "tables.delete": false, "tables.export": false, "customers.edit": true, "customers.view": true, "dashboard.edit": false, "dashboard.view": true, "kitchen.create": false, "kitchen.delete": false, "kitchen.export": false, "new_order.edit": true, "new_order.view": true, "payments.print": true, "reports.create": false, "reports.delete": false, "reports.export": true, "settings.print": false, "customers.print": false, "dashboard.print": false, "kot_groups.edit": true, "kot_groups.view": true, "new_order.print": false, "payments.create": false, "payments.delete": false, "payments.export": false, "settings.create": false, "settings.delete": false, "settings.export": false, "customers.create": true, "customers.delete": false, "customers.export": false, "dashboard.create": false, "dashboard.delete": false, "dashboard.export": false, "kot_groups.print": false, "new_order.create": true, "new_order.delete": false, "new_order.export": false, "kot_groups.create": true, "kot_groups.delete": false, "kot_groups.export": false, "reservations.edit": true, "reservations.view": true, "reservations.print": false, "reservations.create": true, "reservations.delete": false, "reservations.export": false}	2026-09-09 19:54:39.48218	2026-09-11 23:05:28.169992
\.


--
-- Data for Name: app_settings; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.app_settings (id, settings, updated_at) FROM stdin;
1	{"gstin": "22AAAAA0000A1Z5", "phone": "+91 98765 43210", "upiId": "", "footer": "Thank you for visiting!|Please visit again 😊", "header": "Cafe Management System", "showQR": true, "address": "123 Main Market, Indri", "charges": [], "gstRate": 5, "logoUrl": "", "showGST": true, "taxMode": "exclusive", "auditLog": false, "currency": "₹", "autoClose": false, "autoPrint": true, "discounts": [], "showOrder": true, "showTable": true, "uiDensity": "comfortable", "wrapItems": true, "autoBackup": false, "kotEnabled": true, "paperWidth": "80", "showQRCode": true, "accentLabel": "", "closingTime": "23:00", "openingTime": "09:00", "orderPrefix": "ORD-", "receiptFont": "13", "roundTotals": true, "showInvoice": true, "showPayment": true, "showTaxCode": false, "largeBilling": false, "showCustomer": true, "showDiscount": false, "wrapItemName": true, "invoicePrefix": "INV-", "saleBillTitle": "Invoice", "showItemNotes": true, "showOrderType": true, "showTimestamp": true, "defaultPayment": "Cash", "enableKOTSound": false, "restaurantName": "Chai Sutta Bar", "sessionTimeout": 12, "showSaleByUser": false, "uppercaseItems": false, "allowOrderNotes": true, "allowZeroAmount": false, "backupRetention": 30, "customerMessage": "Thank you for visiting!", "designerCompact": false, "showChannelName": false, "showOrderNumber": true, "showTableNumber": true, "defaultOrderType": "Dine-in", "kotAlertInterval": 5, "designerShowNotes": false, "lowStockThreshold": 8, "showCustomerPhone": true, "showInvoiceNumber": true, "showPaymentMethod": true, "uppercaseItemName": false, "enableReceiptSound": false, "enableNotifications": false, "kotDisabledBehavior": "hide", "printKitchenOnOrder": true, "showCustomerDetails": true, "designerShowInvoiceMeta": true}	2026-09-11 21:34:30.486645
\.


--
-- Data for Name: app_users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.app_users (id, display_name, username, profile_id, active, created_at, updated_at, password_hash, business_id) FROM stdin;
2	Manager	Manager	2	t	2026-09-09 19:55:59.307734	2026-09-09 19:55:59.307734	\N	1
81	Mohan	Mohan	3	t	2026-09-11 20:11:20.728186	2026-09-11 20:11:20.728186	8e26de239e52594994f14e5ef5788942:57a7ade4d228a24355beaf46c3101d8ad0df95f8a14e2062c1d44e53c648de63a66056ef2c6add95270a43ac06d5a8ee586899e74d969c5647ab8df8045156d1	1
1	Administrator	admin	1	t	2026-09-09 19:54:39.483504	2026-09-11 23:05:28.313929	bf489b3081df8ee413ce1f4b3275e6c1:2a0e67d2fdd7d26908ccaae2e3dc01c02c8e8422978fbad926ef422ee788e7533f64ebcc2b64841a67ce720a308495ce471eac3731d4c154610d09e301f0c59a	1
4	Manager	manager	2	t	2026-09-09 20:20:04.466493	2026-09-11 23:05:28.416777	581885dd866712bee3b3879c08300059:2194fb20cdb26a0c7f8c908b8e82aeaf0ede35a0a6bd983dfa8f120699109f526e4554a674131b153b2f840261a25536648be08f87e0347616d524ff499d7ed6	1
5	Cashier	cashier	3	t	2026-09-09 20:20:04.585035	2026-09-11 23:05:28.519486	122a16e0e21fefb17670184b383a0d46:e100ec56a4e617371131ea717416012f104d7817dc5402b0c019aeab9564552d0a3c317bc8f0f72dd23a17a1c0d7bce47a48461c648a6ed96bd2636f6e9fa104	1
133	Manojs	admin1234	1	t	2026-09-11 23:06:43.590596	2026-09-11 23:06:43.590596	941b8b93ccd2c5ec808e7d7935276de3:d3fa7ad5dc8d60a7248e1c1f6579b970df3ca60e8c4dc2090b0f97e56b9dc4ca5c7367272a9e495ecb711bb1c9401869692921681fba6ee8912c52df4fa5d51b	4
\.


--
-- Data for Name: billing_adjustments; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.billing_adjustments (id, name, kind, calculation, value, applies_to, description, active, created_at, updated_at) FROM stdin;
1	Happy Hour	discount	percent	10.00	dine-in		t	2026-09-10 13:10:34.968661	2026-09-10 13:10:34.968661
4	Happy Hours	discount	percent	10.00	dine-in		t	2026-09-10 13:11:07.372337	2026-09-10 13:11:07.372337
\.


--
-- Data for Name: businesses; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.businesses (id, business_code, business_name, password_hash, profile_id, active, created_at, updated_at, business_type, owner_name, phone, email, address, city, state, gstin, logo_url, currency) FROM stdin;
1	CAFE001	My Cafe	5b75037da91ed38578ecade45fda6300:75fa5d45b4aa71ad4c2c2069eeea98f44a566e6bab0d2f442897f2fdd7db2c4367a0f6d2f46ab704c894e9b8764fffe8388168a2ff70687d63420f825aeb9dcf	1	t	2026-09-10 01:12:44.501383	2026-09-10 01:12:44.501383	Cafe	\N	\N	\N	\N	\N	\N	\N	\N	₹
4	ABCD-CAFE-MTX8N96V	ABCD Cafe	\N	\N	t	2026-09-11 23:06:43.590596	2026-09-11 23:06:43.590596	Cafe	Manojs	8689092715	gauravrajput9674318@gmail.com	main market karnal	Karnal	Haryana			₹
\.


--
-- Data for Name: customers; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.customers (id, name, phone, email, created_at) FROM stdin;
1	Rahul	9876543210	rahul@example.com	2026-09-05 12:57:11.62326
2	Anshul	8689092712	\N	2026-09-05 13:26:57.147159
3	Rahul	8689092811	\N	2026-09-09 20:57:17.576088
4	Anshul	8689098712	\N	2026-09-10 10:26:46.182478
5	Gaurav Rajput	8686868478	\N	2026-09-10 12:26:49.103193
6	Manoj	897896899	\N	2026-09-11 20:09:07.527347
\.


--
-- Data for Name: expense_categories; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.expense_categories (id, name, active, created_at) FROM stdin;
1	Purchase / Supplies	t	2026-09-09 20:40:48.329115
2	Staff / Salary	t	2026-09-09 20:40:48.333398
3	Rent	t	2026-09-09 20:40:48.334529
4	Utilities	t	2026-09-09 20:40:48.335526
5	Marketing	t	2026-09-09 20:40:48.336542
6	Maintenance	t	2026-09-09 20:40:48.337534
7	Delivery / Logistics	t	2026-09-09 20:40:48.338682
8	Other	t	2026-09-09 20:40:48.339759
\.


--
-- Data for Name: expenses; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.expenses (id, category_id, amount, payment_method, expense_date, note, created_by, created_at) FROM stdin;
1	1	100.00	Cash	2026-09-09	milk	1	2026-09-09 20:55:10.975682
2	6	120.00	Cash	2026-09-11	\N	1	2026-09-11 20:12:25.557832
\.


--
-- Data for Name: invoices; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.invoices (id, invoice_number, order_id, customer_id, invoice_date, subtotal, gst, total, payment_method, status, created_at) FROM stdin;
1	INV-000001	30	\N	2026-09-09 15:49:56.193252	160.00	8.00	168.00	UPI	Generated	2026-09-09 15:49:56.193252
2	INV-000002	31	\N	2026-09-09 15:55:59.877991	160.00	8.00	168.00	Card	Generated	2026-09-09 15:55:59.877991
3	INV-000003	32	\N	2026-09-09 15:58:27.201426	100.00	5.00	105.00	Card	Generated	2026-09-09 15:58:27.201426
4	INV-000004	33	\N	2026-09-09 16:01:19.440857	220.00	11.00	231.00	Card	Generated	2026-09-09 16:01:19.440857
5	INV-000005	34	\N	2026-09-09 17:28:25.904256	180.00	9.00	189.00	Card	Generated	2026-09-09 17:28:25.904256
6	INV-000006	35	\N	2026-09-09 17:33:51.774645	160.00	8.00	168.00	Card	Generated	2026-09-09 17:33:51.774645
7	INV-000007	36	\N	2026-09-09 17:34:24.159233	180.00	9.00	189.00	Card	Generated	2026-09-09 17:34:24.159233
8	INV-000008	37	\N	2026-09-09 17:41:01.950008	580.00	29.00	609.00	UPI	Generated	2026-09-09 17:41:01.950008
9	INV-000009	38	\N	2026-09-09 17:44:42.946391	180.00	9.00	189.00	Card	Generated	2026-09-09 17:44:42.946391
10	INV-000010	39	\N	2026-09-09 17:48:13.27584	100.00	5.00	105.00	Card	Generated	2026-09-09 17:48:13.27584
11	INV-000011	40	\N	2026-09-09 17:52:02.089038	122.00	6.10	128.10	Card	Generated	2026-09-09 17:52:02.089038
12	INV-000012	41	\N	2026-09-09 17:55:07.646758	100.00	5.00	105.00	UPI	Generated	2026-09-09 17:55:07.646758
13	INV-000013	42	2	2026-09-09 18:21:28.106748	220.00	11.00	231.00	UPI	Generated	2026-09-09 18:21:28.106748
14	INV-000014	43	\N	2026-09-09 18:22:19.64945	160.00	8.00	168.00	Card	Generated	2026-09-09 18:22:19.64945
15	INV-000015	44	\N	2026-09-09 18:23:33.40087	180.00	9.00	189.00	Card	Generated	2026-09-09 18:23:33.40087
16	INV-000016	45	\N	2026-09-09 18:25:39.212434	160.00	8.00	168.00	Card	Generated	2026-09-09 18:25:39.212434
17	INV-000017	46	2	2026-09-09 18:41:40.094353	160.00	8.00	168.00	UPI	Generated	2026-09-09 18:41:40.094353
18	INV-000018	47	\N	2026-09-09 20:06:06.127764	160.00	8.00	168.00	UPI	Generated	2026-09-09 20:06:06.127764
19	INV-000019	48	3	2026-09-09 20:57:17.699342	11052.00	552.60	11604.60	UPI	Generated	2026-09-09 20:57:17.699342
20	INV-000020	49	\N	2026-09-09 21:50:38.084921	160.00	8.00	168.00	UPI	Generated	2026-09-09 21:50:38.084921
21	INV-000021	50	\N	2026-09-09 21:52:14.267453	160.00	8.00	168.00	UPI	Generated	2026-09-09 21:52:14.267453
22	INV-000022	51	\N	2026-09-09 21:53:14.540791	160.00	7.91	166.14	UPI	Generated	2026-09-09 21:53:14.540791
23	INV-000023	52	\N	2026-09-09 22:09:43.455384	960.00	48.00	1008.00	UPI	Generated	2026-09-09 22:09:43.455384
24	INV-000024	53	\N	2026-09-09 22:12:10.677067	160.00	8.00	168.00	UPI	Generated	2026-09-09 22:12:10.677067
26	INV-000025	61	\N	2026-09-10 13:52:14.066318	390.00	19.50	410.00	Card	Generated	2026-09-10 13:52:14.066318
25	INV-000026	62	\N	2026-09-10 13:52:14.065523	390.00	19.50	410.00	Card	Generated	2026-09-10 13:52:14.065523
27	INV-000027	63	\N	2026-09-10 14:04:31.877298	80.00	4.00	84.00	UPI	Generated	2026-09-10 14:04:31.877298
28	INV-000028	64	\N	2026-09-11 10:31:55.45714	500.00	25.00	525.00	Card	Generated	2026-09-11 10:31:55.45714
29	INV-000029	65	5	2026-09-11 10:59:54.749029	540.00	27.00	567.00	\N	Generated	2026-09-11 10:59:54.749029
30	INV-000030	75	\N	2026-09-11 20:39:49.969111	240.00	12.00	252.00	Card	Generated	2026-09-11 20:39:49.969111
31	INV-000031	76	\N	2026-09-11 20:40:45.192724	150.00	7.50	158.00	UPI	Generated	2026-09-11 20:40:45.192724
32	INV-000032	77	\N	2026-09-11 20:44:01.712571	150.00	7.50	158.00	Card	Generated	2026-09-11 20:44:01.712571
33	INV-000033	74	\N	2026-09-11 20:44:31.139918	180.00	9.00	189.00	Card	Generated	2026-09-11 20:44:31.139918
34	INV-000034	78	\N	2026-09-11 20:51:47.561471	100.00	5.00	105.00	Card	Generated	2026-09-11 20:51:47.561471
35	INV-000035	80	\N	2026-09-11 22:11:05.034536	432.00	21.60	454.00	Card	Generated	2026-09-11 22:11:05.034536
\.


--
-- Data for Name: kot; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.kot (id, order_id, item_name, quantity, status, created_at, kot_group_id) FROM stdin;
60	48	Masala Tea	1	Completed	2026-09-09 20:57:17.647414	\N
1	8	Cappuccino	3	Completed	2026-09-05 13:54:43.254197	\N
24	22	Cappuccinos	1	Completed	2026-09-09 12:19:02.226292	\N
2	9	Burger	1	Completed	2026-09-06 09:54:26.521014	\N
28	26	Cappuccinos	1	Completed	2026-09-09 14:20:59.693736	\N
3	10	Burger	4	Completed	2026-09-06 09:57:39.082903	\N
25	23	Burger	1	Completed	2026-09-09 14:08:50.283747	\N
4	11	Cappuccino	1	Completed	2026-09-06 10:09:29.672525	\N
6	14	Cappuccino	1	Completed	2026-09-06 10:32:47.190914	\N
5	12	Cappuccino	1	Completed	2026-09-06 10:22:32.741885	\N
7	15	Cappuccino	3	Completed	2026-09-06 11:15:36.030764	\N
33	30	Cappuccinos	1	Completed	2026-09-09 15:49:56.082342	\N
8	16	Noodels	1	Completed	2026-09-06 11:20:19.545623	\N
9	16	Cold Coffee	1	Completed	2026-09-06 11:20:19.545623	\N
11	18	Cappuccinos	1	Completed	2026-09-08 00:35:27.562061	\N
10	17	Cappuccinos	1	Completed	2026-09-07 23:48:59.04823	\N
13	20	Cappuccinos	2	Completed	2026-09-08 09:54:44.109575	\N
14	20	Burger	1	Completed	2026-09-08 09:54:44.109575	\N
15	20	Masala Tea	1	Completed	2026-09-08 09:54:44.109575	\N
12	19	Pasta	1	Completed	2026-09-08 09:35:09.978513	\N
52	46	Cappuccinos	1	Completed	2026-09-09 18:41:40.020095	\N
21	21	Cold Coffee	1	Completed	2026-09-08 10:25:17.106084	\N
22	21	Cold Coffee	1	Completed	2026-09-08 10:25:17.106084	\N
23	21	Masala Tea	1	Completed	2026-09-08 10:25:17.106084	\N
16	21	Cappuccinos	1	Completed	2026-09-08 10:25:17.106084	\N
17	21	Pasta	1	Completed	2026-09-08 10:25:17.106084	\N
18	21	Pizza	1	Completed	2026-09-08 10:25:17.106084	\N
19	21	French Fries	1	Completed	2026-09-08 10:25:17.106084	\N
20	21	Noodels	2	Completed	2026-09-08 10:25:17.106084	\N
50	44	Burger	1	Completed	2026-09-09 18:23:33.298811	\N
67	62	Cold Coffee	1	Ready	2026-09-10 13:52:13.838225	\N
68	62	Cold Coffee	1	Ready	2026-09-10 13:52:13.838225	\N
49	43	Cappuccinos	1	Completed	2026-09-09 18:22:19.593784	\N
27	25	Cold Coffee	1	Completed	2026-09-09 14:19:23.30743	\N
46	40	Noodels	1	Completed	2026-09-09 17:52:02.041412	\N
29	27	Cappuccinos	1	Completed	2026-09-09 14:55:33.061549	\N
30	28	Cold Coffee	1	Completed	2026-09-09 14:56:47.72791	\N
47	41	French Fries	1	Completed	2026-09-09 17:55:07.61997	\N
35	32	French Fries	1	Completed	2026-09-09 15:58:27.178991	\N
31	28	Pasta	1	Completed	2026-09-09 14:56:47.72791	\N
34	31	Cappuccinos	1	Completed	2026-09-09 15:55:59.851691	\N
32	29	Cappuccinos	1	Completed	2026-09-09 15:01:24.589503	\N
36	33	Pasta	1	Completed	2026-09-09 16:01:19.416196	\N
65	61	Cold Coffee	1	Ready	2026-09-10 13:52:12.24098	\N
66	61	Cold Coffee	1	Ready	2026-09-10 13:52:12.24098	\N
69	63	Masala Tea	1	Pending	2026-09-10 14:04:31.813843	\N
70	75	Cold Coffee	1	Pending	2026-09-11 20:39:49.907782	\N
71	76	Cold Coffee	1	Pending	2026-09-11 20:40:45.161418	\N
72	77	Cold Coffee	1	Pending	2026-09-11 20:44:01.675542	\N
73	78	French Fries	1	Pending	2026-09-11 20:51:47.529163	\N
74	80	Noodels — Full	1	Pending	2026-09-11 22:11:04.960747	1
75	80	Cold Coffee	1	Pending	2026-09-11 22:11:04.960747	\N
76	80	Noodels — Half	1	Pending	2026-09-11 22:11:04.960747	1
26	24	Cappuccinos	2	Completed	2026-09-09 14:18:35.985256	\N
37	34	Burger	1	Completed	2026-09-09 17:28:25.878193	\N
38	35	Cappuccinos	1	Completed	2026-09-09 17:33:51.750628	\N
39	36	Burger	1	Completed	2026-09-09 17:34:24.076296	\N
43	37	Masala Tea	1	Completed	2026-09-09 17:41:01.917672	\N
41	37	French Fries	1	Completed	2026-09-09 17:41:01.917672	\N
42	37	Pasta	1	Completed	2026-09-09 17:41:01.917672	\N
40	37	Burger	1	Completed	2026-09-09 17:41:01.917672	\N
44	38	Burger	1	Completed	2026-09-09 17:44:42.919115	\N
45	39	French Fries	1	Completed	2026-09-09 17:48:13.243211	\N
48	42	Pasta	1	Completed	2026-09-09 18:21:28.017469	\N
51	45	Cappuccinos	1	Completed	2026-09-09 18:25:39.185756	\N
53	47	Cappuccinos	1	Completed	2026-09-09 20:06:06.088309	\N
61	49	Cappuccinos	1	Completed	2026-09-09 21:50:38.057118	\N
63	51	Cappuccinos	1	Completed	2026-09-09 21:53:14.506443	\N
62	50	Cappuccinos	1	Completed	2026-09-09 21:52:14.245046	\N
64	52	Cappuccinos	6	Completed	2026-09-09 22:09:43.411667	\N
59	48	Noodels	1	Completed	2026-09-09 20:57:17.647414	\N
58	48	Pizza	35	Completed	2026-09-09 20:57:17.647414	\N
57	48	Pasta	6	Completed	2026-09-09 20:57:17.647414	\N
55	48	Cappuccinos	2	Completed	2026-09-09 20:57:17.647414	\N
54	48	Burger	2	Completed	2026-09-09 20:57:17.647414	\N
56	48	French Fries	1	Completed	2026-09-09 20:57:17.647414	\N
\.


--
-- Data for Name: kot_groups; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.kot_groups (id, name, description, station, sort_order, active, created_at, updated_at) FROM stdin;
1	Main Kitchen	Default KOT group	Kitchen	0	t	2026-09-09 21:47:44.902324	2026-09-09 21:47:44.902324
9	BAR	\N	Bar	-2	t	2026-09-10 10:32:38.056575	2026-09-10 10:32:38.056575
\.


--
-- Data for Name: loyalty_settings; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.loyalty_settings (id, points_per_currency, currency_per_point, min_redeem_points, welcome_points, enabled, updated_at) FROM stdin;
1	1.0000	1.0000	100	0	t	2026-09-09 20:56:23.784068
\.


--
-- Data for Name: loyalty_transactions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.loyalty_transactions (id, customer_id, points, transaction_type, reference_type, reference_id, note, created_at) FROM stdin;
1	3	11604	Earned	Payment	36	Points earned from bill	2026-09-09 20:57:17.687218
2	5	567	Earned	Payment	46	Points earned from bill	2026-09-11 10:59:54.697228
\.


--
-- Data for Name: menu; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.menu (id, name, price, category, available, created_at, kot_group_id, nature, unit, tax_rate, cgst_rate, sgst_rate, igst_rate, tax_mode, tax_label, channel_prices, category_id, image_url) FROM stdin;
9	Cold Coffee	240.00	Coffee	t	2026-09-06 11:19:58.364345	\N	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{}	1	\N
1	Cappuccinos	160.00	Coffee	t	2026-09-03 23:44:16.3827	\N	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{}	1	\N
3	Pizza	250.00	Pizza	t	2026-09-03 23:44:16.3827	\N	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{}	3	\N
7	Masala Tea	80.00	Drinks	t	2026-09-06 10:57:14.34693	\N	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{}	4	\N
2	Burger	180.00	Burgers	t	2026-09-03 23:44:16.3827	\N	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{}	5	\N
4	Pasta	220.00	Food	t	2026-09-03 23:44:16.3827	\N	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{}	6	\N
5	French Fries	100.00	Food	t	2026-09-03 23:44:16.3827	\N	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{}	6	\N
6	Cold Coffee	150.00	Drinks	t	2026-09-03 23:44:16.3827	\N	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{"online": 150, "dine_in": 150, "delivery": 150, "takeaway": 150}	4	\N
8	Noodels	122.00	Chinese	t	2026-09-06 11:11:53.668301	1	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{"online": 122, "dine_in": 122, "delivery": 122, "takeaway": 122}	7	\N
10	nepali	0.00	Nepali	t	2026-09-11 20:59:00.684443	1	Goods	ea	5.00	2.50	2.50	5.00	exclusive	GST 5%	{"dine_in": 120, "takeaway": 120}	\N	\N
\.


--
-- Data for Name: menu_categories; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.menu_categories (id, name, icon, active, sort_order, created_at, updated_at) FROM stdin;
1	Coffee	•	t	4	2026-09-10 01:12:43.593295	2026-09-10 01:12:43.593295
3	Pizza	•	t	9	2026-09-10 01:12:43.593295	2026-09-10 01:12:43.593295
4	Drinks	•	t	5	2026-09-10 01:12:43.593295	2026-09-10 01:12:43.593295
5	Burgers	•	t	1	2026-09-10 01:12:43.593295	2026-09-10 01:12:43.593295
6	Food	•	t	8	2026-09-10 01:12:43.593295	2026-09-10 01:12:43.593295
7	Chinese	•	t	2	2026-09-10 01:12:43.593295	2026-09-10 01:12:43.593295
46	Nepali	•	t	0	2026-09-11 20:58:03.641928	2026-09-11 20:58:03.641928
\.


--
-- Data for Name: menu_variants; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.menu_variants (id, menu_id, name, sku, price, unit, channel_prices, available, created_at, updated_at) FROM stdin;
5	8	Half	\N	70.00	ea	{}	t	2026-09-10 13:56:45.417341	2026-09-10 13:56:45.417341
6	8	Full	\N	122.00	ea	{}	t	2026-09-10 13:56:45.417341	2026-09-10 13:56:45.417341
\.


--
-- Data for Name: order_adjustment_audit; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.order_adjustment_audit (id, order_id, changed_by, change_type, old_discount, new_discount, old_service_charge, new_service_charge, reason, created_at) FROM stdin;
\.


--
-- Data for Name: order_items; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.order_items (id, order_id, menu_id, item_name, price, quantity, line_total, variant_id, unit, tax_rate, tax_mode) FROM stdin;
1	1	\N	Cappuccino	150.00	2	300.00	\N	\N	5.00	exclusive
2	1	\N	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
3	2	\N	Cappuccino	150.00	64	9600.00	\N	\N	5.00	exclusive
4	3	\N	Cappuccino	150.00	36	5400.00	\N	\N	5.00	exclusive
5	4	\N	Cappuccino	150.00	1	150.00	\N	\N	5.00	exclusive
6	5	\N	Cappuccino	150.00	1	150.00	\N	\N	5.00	exclusive
7	6	1	Cappuccino	150.00	1	150.00	\N	\N	5.00	exclusive
8	6	2	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
9	7	2	Burger	180.00	6	1080.00	\N	\N	5.00	exclusive
10	8	1	Cappuccino	150.00	3	450.00	\N	\N	5.00	exclusive
11	9	2	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
12	10	2	Burger	180.00	4	720.00	\N	\N	5.00	exclusive
13	11	1	Cappuccino	150.00	1	150.00	\N	\N	5.00	exclusive
14	12	1	Cappuccino	150.00	1	150.00	\N	\N	5.00	exclusive
15	14	1	Cappuccino	150.00	1	150.00	\N	\N	5.00	exclusive
16	15	1	Cappuccino	150.00	3	450.00	\N	\N	5.00	exclusive
17	16	8	Noodels	122.00	1	122.00	\N	\N	5.00	exclusive
18	16	9	Cold Coffee	240.00	1	240.00	\N	\N	5.00	exclusive
19	17	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
20	18	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
21	19	4	Pasta	220.00	1	220.00	\N	\N	5.00	exclusive
22	20	1	Cappuccinos	160.00	2	320.00	\N	\N	5.00	exclusive
23	20	2	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
24	20	7	Masala Tea	80.00	1	80.00	\N	\N	5.00	exclusive
25	21	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
26	21	4	Pasta	220.00	1	220.00	\N	\N	5.00	exclusive
27	21	3	Pizza	250.00	1	250.00	\N	\N	5.00	exclusive
28	21	5	French Fries	100.00	1	100.00	\N	\N	5.00	exclusive
29	21	8	Noodels	122.00	2	244.00	\N	\N	5.00	exclusive
30	21	6	Cold Coffee	150.00	1	150.00	\N	\N	5.00	exclusive
31	21	9	Cold Coffee	240.00	1	240.00	\N	\N	5.00	exclusive
32	21	7	Masala Tea	80.00	1	80.00	\N	\N	5.00	exclusive
33	22	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
34	23	2	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
35	24	1	Cappuccinos	160.00	2	320.00	\N	\N	5.00	exclusive
36	25	9	Cold Coffee	240.00	1	240.00	\N	\N	5.00	exclusive
37	26	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
38	27	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
39	28	9	Cold Coffee	240.00	1	240.00	\N	\N	5.00	exclusive
40	28	4	Pasta	220.00	1	220.00	\N	\N	5.00	exclusive
41	29	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
42	30	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
43	31	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
44	32	5	French Fries	100.00	1	100.00	\N	\N	5.00	exclusive
45	33	4	Pasta	220.00	1	220.00	\N	\N	5.00	exclusive
46	34	2	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
47	35	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
48	36	2	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
49	37	2	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
50	37	5	French Fries	100.00	1	100.00	\N	\N	5.00	exclusive
51	37	4	Pasta	220.00	1	220.00	\N	\N	5.00	exclusive
52	37	7	Masala Tea	80.00	1	80.00	\N	\N	5.00	exclusive
53	38	2	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
54	39	5	French Fries	100.00	1	100.00	\N	\N	5.00	exclusive
55	40	8	Noodels	122.00	1	122.00	\N	\N	5.00	exclusive
56	41	5	French Fries	100.00	1	100.00	\N	\N	5.00	exclusive
57	42	4	Pasta	220.00	1	220.00	\N	\N	5.00	exclusive
58	43	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
59	44	2	Burger	180.00	1	180.00	\N	\N	5.00	exclusive
60	45	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
61	46	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
62	47	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
63	48	2	Burger	180.00	2	360.00	\N	\N	5.00	exclusive
64	48	1	Cappuccinos	160.00	2	320.00	\N	\N	5.00	exclusive
65	48	5	French Fries	100.00	1	100.00	\N	\N	5.00	exclusive
66	48	4	Pasta	220.00	6	1320.00	\N	\N	5.00	exclusive
67	48	3	Pizza	250.00	35	8750.00	\N	\N	5.00	exclusive
68	48	8	Noodels	122.00	1	122.00	\N	\N	5.00	exclusive
69	48	7	Masala Tea	80.00	1	80.00	\N	\N	5.00	exclusive
70	49	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
71	50	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
72	51	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
73	52	1	Cappuccinos	160.00	6	960.00	\N	\N	5.00	exclusive
74	53	1	Cappuccinos	160.00	1	160.00	\N	\N	5.00	exclusive
75	61	6	Cold Coffee	150.00	1	150.00	\N	ea	5.00	exclusive
76	61	9	Cold Coffee	240.00	1	240.00	\N	ea	5.00	exclusive
77	62	6	Cold Coffee	150.00	1	150.00	\N	ea	5.00	exclusive
78	62	9	Cold Coffee	240.00	1	240.00	\N	ea	5.00	exclusive
79	63	7	Masala Tea	80.00	1	80.00	\N	ea	5.00	exclusive
80	64	2	Burger	180.00	2	360.00	\N	ea	5.00	exclusive
81	64	8	Noodels — Half	70.00	2	140.00	5	ea	5.00	exclusive
83	65	2	Burger	180.00	3	540.00	\N	ea	5.00	exclusive
85	75	9	Cold Coffee	240.00	1	240.00	\N	ea	5.00	exclusive
86	76	6	Cold Coffee	150.00	1	150.00	\N	ea	5.00	exclusive
87	77	6	Cold Coffee	150.00	1	150.00	\N	ea	5.00	exclusive
88	74	2	Burger	180.00	1	180.00	\N	ea	5.00	exclusive
89	78	5	French Fries	100.00	1	100.00	\N	ea	5.00	exclusive
90	79	7	Masala Tea	80.00	1	80.00	\N	ea	5.00	exclusive
91	80	8	Noodels — Full	122.00	1	122.00	6	ea	5.00	exclusive
92	80	9	Cold Coffee	240.00	1	240.00	\N	ea	5.00	exclusive
93	80	8	Noodels — Half	70.00	1	70.00	5	ea	5.00	exclusive
\.


--
-- Data for Name: orders; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.orders (id, order_number, order_type, table_number, subtotal, gst, total, payment_method, status, created_at, customer_id, discount, service_charge, notes, adjustment_meta, updated_at, discount_adjustment_id, charge_adjustment_id) FROM stdin;
1	ORD-9170	Dine-in	1	480.00	24.00	504.00	Cash	Completed	2026-09-04 11:58:23.408683	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
2	ORD-8755	Dine-in	1	9600.00	480.00	10080.00	UPI	Completed	2026-09-04 12:11:50.899874	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
3	ORD-1193	Dine-in	1	5400.00	270.00	5670.00	Cash	Completed	2026-09-04 12:25:45.597425	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
4	ORD-2354	Dine-in	1	150.00	7.50	157.50	Card	Completed	2026-09-05 12:32:59.128745	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
5	ORD-3183	Dine-in	1	150.00	7.50	157.50	Card	Completed	2026-09-05 12:32:59.412162	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
6	ORD-6054	Dine-in	1	330.00	16.50	346.50	Cash	Completed	2026-09-05 12:40:45.024064	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
7	ORD-3201	Dine-in	1	1080.00	54.00	1134.00	UPI	Completed	2026-09-05 12:54:15.673107	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
8	ORD-6226	Dine-in	1	450.00	22.50	472.50	Cash	Completed	2026-09-05 13:54:43.254197	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
9	ORD-8870	Dine-in	1	180.00	9.00	189.00	UPI	Completed	2026-09-06 09:54:26.521014	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
11	ORD-7516	Dine-in	1	150.00	7.50	157.50	UPI	Completed	2026-09-06 10:09:29.672525	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
14	ORD-6243	Dine-in	1	150.00	7.50	157.50	Card	Completed	2026-09-06 10:32:47.190914	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
12	ORD-8547	Dine-in	1	150.00	7.50	157.50	UPI	Completed	2026-09-06 10:22:32.741885	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
15	ORD-4188	Dine-in	1	450.00	22.50	472.50	UPI	Completed	2026-09-06 11:15:36.030764	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
16	ORD-6811	Dine-in	1	362.00	18.10	380.10	UPI	Completed	2026-09-06 11:20:19.545623	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
18	ORD-07927251	Dine-in	T5	160.00	8.00	168.00	UPI	Completed	2026-09-08 00:35:27.562061	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
17	ORD-8848	Dine-in	T2	160.00	8.00	168.00	UPI	Completed	2026-09-07 23:48:59.04823	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
20	ORD-41483906	Dine-in	T3	580.00	29.00	609.00	UPI	Cancelled	2026-09-08 09:54:44.109575	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
25	ORD-43763253	Dine-in	T2	240.00	12.00	252.00	UPI	Completed	2026-09-09 14:19:23.30743	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
19	ORD-40309794	Dine-in	T5	220.00	11.00	231.00	UPI	Completed	2026-09-08 09:35:09.978513	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
21	ORD-43317044	Dine-in	T2	1444.00	72.20	1516.20	UPI	Completed	2026-09-08 10:25:17.106084	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
22	ORD-36541606	Dine-in	T2	160.00	8.00	168.00	UPI	Completed	2026-09-09 12:19:02.226292	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
23	ORD-43129928	Dine-in	T6	180.00	9.00	189.00	UPI	Completed	2026-09-09 14:08:50.283747	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
30	ORD-49196050	Dine-in	T6	160.00	8.00	168.00	UPI	Cancelled	2026-09-09 15:49:56.082342	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
46	ORD-59500014	Dine-in	T4	160.00	8.00	168.00	UPI	Completed	2026-09-09 18:41:40.020095	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
44	ORD-58413294	Takeaway	\N	180.00	9.00	189.00	Card	Completed	2026-09-09 18:23:33.298811	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
43	ORD-58339588	Takeaway	\N	160.00	8.00	168.00	Card	Completed	2026-09-09 18:22:19.593784	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
32	ORD-49707173	Takeaway	\N	100.00	5.00	105.00	Card	Completed	2026-09-09 15:58:27.178991	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
31	ORD-49559846	Takeaway	\N	160.00	8.00	168.00	Card	Completed	2026-09-09 15:55:59.851691	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
24	ORD-43715978	Takeaway	\N	320.00	16.00	336.00	UPI	Completed	2026-09-09 14:18:35.985256	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
26	ORD-43859635	Takeaway	\N	160.00	8.00	168.00	UPI	Completed	2026-09-09 14:20:59.693736	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
40	ORD-56522012	Takeaway	\N	122.00	6.10	128.10	Card	Completed	2026-09-09 17:52:02.041412	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
41	ORD-56707614	Dine-in	T8	100.00	5.00	105.00	UPI	Completed	2026-09-09 17:55:07.61997	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
27	ORD-45933056	Takeaway	\N	160.00	8.00	168.00	Card	Completed	2026-09-09 14:55:33.061549	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
28	ORD-46007672	Takeaway	\N	460.00	23.00	483.00	Card	Completed	2026-09-09 14:56:47.72791	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
29	ORD-46284585	Takeaway	\N	160.00	8.00	168.00	UPI	Completed	2026-09-09 15:01:24.589503	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
33	ORD-49879412	Takeaway	\N	220.00	11.00	231.00	Card	Completed	2026-09-09 16:01:19.416196	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
34	ORD-55105872	Takeaway	\N	180.00	9.00	189.00	Card	Completed	2026-09-09 17:28:25.878193	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
35	ORD-55431745	Takeaway	\N	160.00	8.00	168.00	Card	Completed	2026-09-09 17:33:51.750628	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
36	ORD-55464005	Takeaway	\N	180.00	9.00	189.00	Card	Completed	2026-09-09 17:34:24.076296	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
37	ORD-55861912	Takeaway	\N	580.00	29.00	609.00	UPI	Completed	2026-09-09 17:41:01.917672	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
38	ORD-56082914	Takeaway	\N	180.00	9.00	189.00	Card	Completed	2026-09-09 17:44:42.919115	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
39	ORD-56293079	Takeaway	\N	100.00	5.00	105.00	Card	Completed	2026-09-09 17:48:13.243211	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
42	ORD-58287639	Takeaway	\N	220.00	11.00	231.00	UPI	Completed	2026-09-09 18:21:28.017469	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
45	ORD-58539181	Takeaway	\N	160.00	8.00	168.00	Card	Completed	2026-09-09 18:25:39.185756	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
47	ORD-64566031	Dine-in	T4	160.00	8.00	168.00	UPI	Completed	2026-09-09 20:06:06.088309	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
49	ORD-70838051	Takeaway	\N	160.00	8.00	168.00	UPI	Completed	2026-09-09 21:50:38.057118	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
51	ORD-70994437	Takeaway	\N	160.00	7.91	166.14	UPI	Completed	2026-09-09 21:53:14.506443	\N	1.77	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
50	ORD-70934240	Takeaway	\N	160.00	8.00	168.00	UPI	Completed	2026-09-09 21:52:14.245046	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
52	ORD-71983345	Dine-in	T7	960.00	48.00	1008.00	UPI	Completed	2026-09-09 22:09:43.411667	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
48	ORD-67637641	Dine-in	T5	11052.00	552.60	11604.60	UPI	Completed	2026-09-09 20:57:17.647414	3	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
53	ORD-72130569	Dine-in	T3	160.00	8.00	168.00	UPI	Completed	2026-09-09 22:12:10.634073	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
10	ORD-9365	Dine-in	1	720.00	36.00	756.00	Card	Cancelled	2026-09-06 09:57:39.082903	\N	0.00	0.00	\N	{}	2026-09-10 13:08:43.913893	\N	\N
61	ORD-28532162	Takeaway	\N	390.00	19.50	410.00	Card	Completed	2026-09-10 13:52:12.24098	\N	0.00	0.00	\N	{}	2026-09-10 13:52:12.24098	\N	\N
62	ORD-28533628	Takeaway	\N	390.00	19.50	410.00	Card	Completed	2026-09-10 13:52:13.838225	\N	0.00	0.00	\N	{}	2026-09-10 13:52:13.838225	\N	\N
63	ORD-29271635	Takeaway	\N	80.00	4.00	84.00	UPI	Completed	2026-09-10 14:04:31.813843	\N	0.00	0.00	\N	{}	2026-09-10 14:04:31.813843	\N	\N
64	ORD-02914486	Takeaway	\N	500.00	25.00	525.00	Card	Completed	2026-09-11 10:31:54.770563	\N	0.00	0.00	\N	{}	2026-09-11 10:31:54.770563	\N	\N
65	ORD-02939142	Takeaway	\N	540.00	27.00	567.00	\N	Completed	2026-09-11 10:32:19.147442	5	0.00	0.00	\N	{}	2026-09-11 10:59:54.559468	\N	\N
75	ORD-39389902	Takeaway	\N	240.00	12.00	252.00	Card	Completed	2026-09-11 20:39:49.907782	\N	0.00	0.00	\N	{}	2026-09-11 20:39:49.907782	\N	\N
76	ORD-39445156	Takeaway	\N	150.00	7.50	158.00	UPI	Completed	2026-09-11 20:40:45.161418	\N	0.00	0.00	\N	{}	2026-09-11 20:40:45.161418	\N	\N
77	ORD-39641611	Takeaway	\N	150.00	7.50	158.00	Card	Completed	2026-09-11 20:44:01.675542	\N	0.00	0.00	\N	{}	2026-09-11 20:44:01.675542	\N	\N
74	ORD-39379681	Takeaway	\N	180.00	9.00	189.00	Card	Completed	2026-09-11 20:39:39.748384	\N	0.00	0.00	\N	{}	2026-09-11 20:39:39.748384	\N	\N
78	ORD-40107521	Dine-in	T11	100.00	5.00	105.00	Card	Completed	2026-09-11 20:51:47.529163	\N	0.00	0.00	\N	{}	2026-09-11 20:51:47.529163	\N	\N
79	ORD-40131817	Dine-in	T5	80.00	4.00	84.00	\N	Open	2026-09-11 20:52:11.822935	\N	0.00	0.00	\N	{}	2026-09-11 20:52:11.822935	\N	\N
80	ORD-44864953	Dine-in	T3	432.00	21.60	454.00	Card	Completed	2026-09-11 22:11:04.960747	\N	0.00	0.00	\N	{}	2026-09-11 22:11:04.960747	\N	\N
\.


--
-- Data for Name: payments; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.payments (id, order_id, order_number, amount, payment_method, payment_status, transaction_id, created_at, updated_at) FROM stdin;
1	12	ORD-8547	157.50	UPI	Paid	\N	2026-09-06 10:22:32.76495	2026-09-10 09:33:27.445527
2	14	ORD-6243	157.50	Card	Paid	\N	2026-09-06 10:32:47.218107	2026-09-10 09:33:27.445527
3	15	ORD-4188	472.50	UPI	Paid	\N	2026-09-06 11:15:36.078848	2026-09-10 09:33:27.445527
4	16	ORD-6811	380.10	UPI	Paid	\N	2026-09-06 11:20:19.568118	2026-09-10 09:33:27.445527
5	17	ORD-8848	168.00	UPI	Success	\N	2026-09-07 23:48:59.405176	2026-09-10 09:33:27.445527
6	18	ORD-07927251	168.00	UPI	Success	\N	2026-09-08 00:35:27.596352	2026-09-10 09:33:27.445527
7	19	ORD-40309794	231.00	UPI	Success	\N	2026-09-08 09:35:09.999313	2026-09-10 09:33:27.445527
8	20	ORD-41483906	609.00	UPI	Success	\N	2026-09-08 09:54:44.160479	2026-09-10 09:33:27.445527
9	21	ORD-43317044	1516.20	UPI	Success	\N	2026-09-08 10:25:17.181416	2026-09-10 09:33:27.445527
10	22	ORD-36541606	168.00	UPI	Success	\N	2026-09-09 12:19:02.569955	2026-09-10 09:33:27.445527
11	23	ORD-43129928	189.00	UPI	Success	\N	2026-09-09 14:08:50.366277	2026-09-10 09:33:27.445527
12	24	ORD-43715978	336.00	UPI	Success	\N	2026-09-09 14:18:36.009789	2026-09-10 09:33:27.445527
13	25	ORD-43763253	252.00	UPI	Success	\N	2026-09-09 14:19:23.376129	2026-09-10 09:33:27.445527
14	26	ORD-43859635	168.00	UPI	Success	\N	2026-09-09 14:20:59.715939	2026-09-10 09:33:27.445527
15	27	ORD-45933056	168.00	Card	Success	\N	2026-09-09 14:55:33.081247	2026-09-10 09:33:27.445527
16	28	ORD-46007672	483.00	Card	Success	\N	2026-09-09 14:56:47.748863	2026-09-10 09:33:27.445527
17	29	ORD-46284585	168.00	UPI	Success	\N	2026-09-09 15:01:24.608756	2026-09-10 09:33:27.445527
18	30	ORD-49196050	168.00	UPI	Success	\N	2026-09-09 15:49:56.17287	2026-09-10 09:33:27.445527
19	31	ORD-49559846	168.00	Card	Success	\N	2026-09-09 15:55:59.870153	2026-09-10 09:33:27.445527
20	32	ORD-49707173	105.00	Card	Success	\N	2026-09-09 15:58:27.193282	2026-09-10 09:33:27.445527
21	33	ORD-49879412	231.00	Card	Success	\N	2026-09-09 16:01:19.433448	2026-09-10 09:33:27.445527
22	34	ORD-55105872	189.00	Card	Success	\N	2026-09-09 17:28:25.896664	2026-09-10 09:33:27.445527
23	35	ORD-55431745	168.00	Card	Success	\N	2026-09-09 17:33:51.767256	2026-09-10 09:33:27.445527
24	36	ORD-55464005	189.00	Card	Success	\N	2026-09-09 17:34:24.106249	2026-09-10 09:33:27.445527
25	37	ORD-55861912	609.00	UPI	Success	\N	2026-09-09 17:41:01.941977	2026-09-10 09:33:27.445527
26	38	ORD-56082914	189.00	Card	Success	\N	2026-09-09 17:44:42.939067	2026-09-10 09:33:27.445527
27	39	ORD-56293079	105.00	Card	Success	\N	2026-09-09 17:48:13.268488	2026-09-10 09:33:27.445527
28	40	ORD-56522012	128.10	Card	Success	\N	2026-09-09 17:52:02.080502	2026-09-10 09:33:27.445527
29	41	ORD-56707614	105.00	UPI	Success	\N	2026-09-09 17:55:07.639002	2026-09-10 09:33:27.445527
30	42	ORD-58287639	231.00	UPI	Success	\N	2026-09-09 18:21:28.064383	2026-09-10 09:33:27.445527
31	43	ORD-58339588	168.00	Card	Success	\N	2026-09-09 18:22:19.625241	2026-09-10 09:33:27.445527
32	44	ORD-58413294	189.00	Card	Success	\N	2026-09-09 18:23:33.384705	2026-09-10 09:33:27.445527
33	45	ORD-58539181	168.00	Card	Success	\N	2026-09-09 18:25:39.204527	2026-09-10 09:33:27.445527
34	46	ORD-59500014	168.00	UPI	Success	\N	2026-09-09 18:41:40.054943	2026-09-10 09:33:27.445527
35	47	ORD-64566031	168.00	UPI	Success	\N	2026-09-09 20:06:06.118155	2026-09-10 09:33:27.445527
36	48	ORD-67637641	11604.60	UPI	Success	\N	2026-09-09 20:57:17.679863	2026-09-10 09:33:27.445527
37	49	ORD-70838051	168.00	UPI	Success	\N	2026-09-09 21:50:38.075034	2026-09-10 09:33:27.445527
38	50	ORD-70934240	168.00	UPI	Success	\N	2026-09-09 21:52:14.2582	2026-09-10 09:33:27.445527
39	51	ORD-70994437	166.14	UPI	Success	\N	2026-09-09 21:53:14.528602	2026-09-10 09:33:27.445527
40	52	ORD-71983345	1008.00	UPI	Success	\N	2026-09-09 22:09:43.44254	2026-09-10 09:33:27.445527
41	53	ORD-72130569	168.00	UPI	Success	\N	2026-09-09 22:12:10.66683	2026-09-10 09:33:27.445527
42	61	ORD-28532162	410.00	Card	Success	\N	2026-09-10 13:52:13.9604	2026-09-10 13:52:13.9604
43	62	ORD-28533628	410.00	Card	Success	\N	2026-09-10 13:52:13.960981	2026-09-10 13:52:13.960981
44	63	ORD-29271635	84.00	UPI	Success	\N	2026-09-10 14:04:31.868323	2026-09-10 14:04:31.868323
45	64	ORD-02914486	525.00	Card	Success	\N	2026-09-11 10:31:55.408188	2026-09-11 10:31:55.408188
46	65	ORD-02939142	567.00	Card	Success	\N	2026-09-11 10:59:54.678429	2026-09-11 10:59:54.678429
47	75	ORD-39389902	252.00	Card	Success	\N	2026-09-11 20:39:49.959414	2026-09-11 20:39:49.959414
48	76	ORD-39445156	158.00	UPI	Success	\N	2026-09-11 20:40:45.183835	2026-09-11 20:40:45.183835
49	77	ORD-39641611	158.00	Card	Success	\N	2026-09-11 20:44:01.703465	2026-09-11 20:44:01.703465
50	74	ORD-39379681	189.00	Card	Success	\N	2026-09-11 20:44:31.131121	2026-09-11 20:44:31.131121
51	78	ORD-40107521	105.00	Card	Success	\N	2026-09-11 20:51:47.551755	2026-09-11 20:51:47.551755
52	80	ORD-44864953	454.00	Card	Success	\N	2026-09-11 22:11:05.022593	2026-09-11 22:11:05.022593
\.


--
-- Data for Name: reservations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.reservations (id, customer_name, phone, reservation_date, reservation_time, guests, table_number, status, notes, created_at) FROM stdin;
1	Loki Vegetable	9996502712	2000-09-12	20:12:00	1	2	Arrived	\N	2026-09-05 13:44:24.067258
2	Gaurav Rajput	895686868	2026-09-22	08:09:00	2	T8	Reserved	\N	2026-09-11 20:06:59.958987
\.


--
-- Data for Name: restaurant_tables; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.restaurant_tables (id, table_number, capacity, status, created_at) FROM stdin;
8	T8	8	Reserved	2026-09-07 10:57:20.658331
12	T 12	4	Available	2026-09-11 20:07:23.384865
11	T11	4	Available	2026-09-08 09:49:40.254256
5	T5	4	Occupied	2026-09-07 10:57:20.658331
3	T3	4	Available	2026-09-07 10:57:20.658331
10	T9	4	Available	2026-09-07 23:57:47.242364
6	T6	6	Available	2026-09-07 10:57:20.658331
2	T2	2	Available	2026-09-07 10:57:20.658331
4	T4	4	Available	2026-09-07 10:57:20.658331
7	T7	6	Available	2026-09-07 10:57:20.658331
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, name, username, password, role, active, created_at) FROM stdin;
1	Administrator	admin	admin123	admin	t	2026-09-08 14:07:51.976616
\.


--
-- Name: access_profiles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.access_profiles_id_seq', 3, true);


--
-- Name: app_users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.app_users_id_seq', 133, true);


--
-- Name: billing_adjustments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.billing_adjustments_id_seq', 7, true);


--
-- Name: businesses_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.businesses_id_seq', 4, true);


--
-- Name: customers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.customers_id_seq', 6, true);


--
-- Name: expense_categories_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.expense_categories_id_seq', 336, true);


--
-- Name: expenses_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.expenses_id_seq', 2, true);


--
-- Name: invoice_number_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.invoice_number_seq', 35, true);


--
-- Name: invoices_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.invoices_id_seq', 35, true);


--
-- Name: kot_groups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.kot_groups_id_seq', 41, true);


--
-- Name: kot_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.kot_id_seq', 76, true);


--
-- Name: loyalty_transactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.loyalty_transactions_id_seq', 2, true);


--
-- Name: menu_categories_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.menu_categories_id_seq', 46, true);


--
-- Name: menu_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.menu_id_seq', 10, true);


--
-- Name: menu_variants_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.menu_variants_id_seq', 6, true);


--
-- Name: order_adjustment_audit_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.order_adjustment_audit_id_seq', 1, false);


--
-- Name: order_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.order_items_id_seq', 93, true);


--
-- Name: orders_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.orders_id_seq', 80, true);


--
-- Name: payments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.payments_id_seq', 52, true);


--
-- Name: reservations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.reservations_id_seq', 2, true);


--
-- Name: restaurant_tables_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.restaurant_tables_id_seq', 12, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.users_id_seq', 1, true);


--
-- Name: access_profiles access_profiles_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.access_profiles
    ADD CONSTRAINT access_profiles_name_key UNIQUE (name);


--
-- Name: access_profiles access_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.access_profiles
    ADD CONSTRAINT access_profiles_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_username_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_username_key UNIQUE (username);


--
-- Name: billing_adjustments billing_adjustments_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.billing_adjustments
    ADD CONSTRAINT billing_adjustments_name_key UNIQUE (name);


--
-- Name: billing_adjustments billing_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.billing_adjustments
    ADD CONSTRAINT billing_adjustments_pkey PRIMARY KEY (id);


--
-- Name: businesses businesses_business_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_business_code_key UNIQUE (business_code);


--
-- Name: businesses businesses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_pkey PRIMARY KEY (id);


--
-- Name: customers customers_phone_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_phone_key UNIQUE (phone);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: expense_categories expense_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_name_key UNIQUE (name);


--
-- Name: expense_categories expense_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);


--
-- Name: invoices invoices_order_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_order_id_key UNIQUE (order_id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: kot_groups kot_groups_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.kot_groups
    ADD CONSTRAINT kot_groups_name_key UNIQUE (name);


--
-- Name: kot_groups kot_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.kot_groups
    ADD CONSTRAINT kot_groups_pkey PRIMARY KEY (id);


--
-- Name: kot kot_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.kot
    ADD CONSTRAINT kot_pkey PRIMARY KEY (id);


--
-- Name: loyalty_settings loyalty_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.loyalty_settings
    ADD CONSTRAINT loyalty_settings_pkey PRIMARY KEY (id);


--
-- Name: loyalty_transactions loyalty_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.loyalty_transactions
    ADD CONSTRAINT loyalty_transactions_pkey PRIMARY KEY (id);


--
-- Name: loyalty_transactions loyalty_transactions_reference_type_reference_id_transactio_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.loyalty_transactions
    ADD CONSTRAINT loyalty_transactions_reference_type_reference_id_transactio_key UNIQUE (reference_type, reference_id, transaction_type);


--
-- Name: menu_categories menu_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu_categories
    ADD CONSTRAINT menu_categories_name_key UNIQUE (name);


--
-- Name: menu_categories menu_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu_categories
    ADD CONSTRAINT menu_categories_pkey PRIMARY KEY (id);


--
-- Name: menu menu_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu
    ADD CONSTRAINT menu_pkey PRIMARY KEY (id);


--
-- Name: menu_variants menu_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu_variants
    ADD CONSTRAINT menu_variants_pkey PRIMARY KEY (id);


--
-- Name: order_adjustment_audit order_adjustment_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_adjustment_audit
    ADD CONSTRAINT order_adjustment_audit_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: orders orders_order_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_order_number_key UNIQUE (order_number);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: reservations reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_pkey PRIMARY KEY (id);


--
-- Name: restaurant_tables restaurant_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT restaurant_tables_pkey PRIMARY KEY (id);


--
-- Name: restaurant_tables restaurant_tables_table_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT restaurant_tables_table_number_key UNIQUE (table_number);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: idx_billing_adjustments_kind_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_billing_adjustments_kind_active ON public.billing_adjustments USING btree (kind, active);


--
-- Name: idx_businesses_business_code; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_businesses_business_code ON public.businesses USING btree (business_code);


--
-- Name: idx_expenses_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_expenses_date ON public.expenses USING btree (expense_date DESC);


--
-- Name: idx_loyalty_customer; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_loyalty_customer ON public.loyalty_transactions USING btree (customer_id, created_at DESC);


--
-- Name: idx_menu_categories_active_sort; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_menu_categories_active_sort ON public.menu_categories USING btree (active, sort_order, name);


--
-- Name: idx_menu_variants_menu; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_menu_variants_menu ON public.menu_variants USING btree (menu_id);


--
-- Name: app_users app_users_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE SET NULL;


--
-- Name: app_users app_users_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.access_profiles(id) ON DELETE SET NULL;


--
-- Name: businesses businesses_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.access_profiles(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.expense_categories(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;


--
-- Name: kot kot_kot_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.kot
    ADD CONSTRAINT kot_kot_group_id_fkey FOREIGN KEY (kot_group_id) REFERENCES public.kot_groups(id) ON DELETE SET NULL;


--
-- Name: kot kot_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.kot
    ADD CONSTRAINT kot_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: loyalty_transactions loyalty_transactions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.loyalty_transactions
    ADD CONSTRAINT loyalty_transactions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: menu menu_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu
    ADD CONSTRAINT menu_category_fk FOREIGN KEY (category_id) REFERENCES public.menu_categories(id) ON DELETE SET NULL;


--
-- Name: menu menu_kot_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu
    ADD CONSTRAINT menu_kot_group_id_fkey FOREIGN KEY (kot_group_id) REFERENCES public.kot_groups(id) ON DELETE SET NULL;


--
-- Name: menu_variants menu_variants_menu_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.menu_variants
    ADD CONSTRAINT menu_variants_menu_id_fkey FOREIGN KEY (menu_id) REFERENCES public.menu(id) ON DELETE CASCADE;


--
-- Name: order_adjustment_audit order_adjustment_audit_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_adjustment_audit
    ADD CONSTRAINT order_adjustment_audit_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_menu_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_menu_id_fkey FOREIGN KEY (menu_id) REFERENCES public.menu(id);


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.menu_variants(id) ON DELETE SET NULL;


--
-- Name: orders orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: payments payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict ayPhUCE4R2DjrSetkBbqrcXmvIgvYn9xZY8MGOt6NgzWycaP729Xven5xDakAF7

