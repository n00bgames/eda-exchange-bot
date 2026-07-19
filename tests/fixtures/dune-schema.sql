-- Minimal replica of the Dune Awakening exchange schema: only the tables,
-- columns, and SQL functions the addon's generated SQL touches. BIGINT ids
-- everywhere so 64-bit exchange/actor/item ids round-trip exactly.

CREATE SCHEMA dune;

CREATE TABLE dune.world_partition (
    partition_id BIGINT PRIMARY KEY
);

CREATE TABLE dune.actors (
    id BIGSERIAL PRIMARY KEY,
    class TEXT NOT NULL,
    serial BIGINT NOT NULL DEFAULT 0,
    gas_attributes TEXT NOT NULL DEFAULT '{}',
    properties TEXT NOT NULL DEFAULT '{}',
    dimension_index BIGINT NOT NULL DEFAULT 0,
    partition_id BIGINT
);

CREATE TABLE dune.dune_exchanges (
    id BIGINT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE dune.dune_exchange_accesspoints (
    id BIGSERIAL PRIMARY KEY,
    exchange_id BIGINT NOT NULL
);

CREATE TABLE dune.items (
    id BIGSERIAL PRIMARY KEY,
    inventory_id BIGINT NOT NULL,
    stack_size BIGINT NOT NULL,
    position_index BIGINT NOT NULL,
    template_id TEXT NOT NULL,
    quality_level BIGINT NOT NULL DEFAULT 0,
    stats TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE dune.dune_exchange_orders (
    id BIGSERIAL PRIMARY KEY,
    exchange_id BIGINT NOT NULL,
    access_point_id BIGINT REFERENCES dune.dune_exchange_accesspoints(id),
    owner_id BIGINT NOT NULL,
    is_npc_order BOOLEAN NOT NULL DEFAULT FALSE,
    expiration_time BIGINT NOT NULL,
    template_id TEXT NOT NULL,
    durability_cur DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    durability_max DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    category_mask BIGINT NOT NULL DEFAULT 0,
    category_depth BIGINT NOT NULL DEFAULT 0,
    item_price BIGINT NOT NULL DEFAULT 0,
    quality_level BIGINT NOT NULL DEFAULT 0,
    item_id BIGINT
);

CREATE TABLE dune.dune_exchange_sell_orders (
    order_id BIGINT PRIMARY KEY REFERENCES dune.dune_exchange_orders(id),
    initial_stack_size BIGINT NOT NULL,
    wear_normalized_price BIGINT NOT NULL
);

CREATE TABLE dune.dune_exchange_users (
    user_id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL UNIQUE,
    solari_balance BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE dune.dune_exchange_fulfilled_orders (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL,
    source_order_id BIGINT,
    completion_type BIGINT NOT NULL,
    stack_size BIGINT NOT NULL,
    original_order_id BIGINT
);

CREATE TABLE dune.dune_exchange_categories_hash (
    id BIGINT PRIMARY KEY,
    hash BIGINT NOT NULL
);

CREATE FUNCTION dune.get_dune_exchange_id(p_name TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
    SELECT id FROM dune.dune_exchanges WHERE name = p_name;
$$;

-- The real schema maps each exchange to a dedicated inventory; identity is
-- enough for tests since only uniqueness per exchange matters.
CREATE FUNCTION dune.get_exchange_inventory_id(p_exchange_id BIGINT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
    SELECT p_exchange_id;
$$;

CREATE FUNCTION dune.dune_exchange_get_user_id(p_owner_id BIGINT) RETURNS BIGINT
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO dune.dune_exchange_users (owner_id)
    VALUES (p_owner_id)
    ON CONFLICT (owner_id) DO NOTHING;
    RETURN (SELECT user_id FROM dune.dune_exchange_users WHERE owner_id = p_owner_id);
END;
$$;

CREATE FUNCTION dune.dune_exchange_retrieve_solari_balance(p_owner_id BIGINT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
    SELECT solari_balance FROM dune.dune_exchange_users WHERE owner_id = p_owner_id;
$$;

CREATE FUNCTION dune.dune_exchange_modify_user_solari_balance(p_owner_id BIGINT, p_delta BIGINT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO dune.dune_exchange_users (owner_id, solari_balance)
    VALUES (p_owner_id, p_delta)
    ON CONFLICT (owner_id) DO UPDATE
        SET solari_balance = dune_exchange_users.solari_balance + p_delta;
END;
$$;

INSERT INTO dune.world_partition (partition_id) VALUES (1);
INSERT INTO dune.dune_exchanges (id, name) VALUES (1, 'Global');
